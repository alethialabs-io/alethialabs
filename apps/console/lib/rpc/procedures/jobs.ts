// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { presetRange } from "@repo/ui/range";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import { z } from "zod";
import { JOB_FINISHED_STATUSES, JOB_LOG_SETTLE_MS } from "@/components/jobs/job-log-contract";
import { JOBS_PAGE_MAX, JOBS_PAGE_SIZE } from "@/components/jobs/jobs-query";
import { ActionRefusal } from "@/lib/actions/result";
import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import type { Actor, BulkCheck } from "@/lib/authz/types";
import { withScope } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	applyApprovals,
	cloudIdentities,
	jobLogs,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { provisionJobStatus, provisionJobType } from "@/lib/db/schema/enums";
import { permissionToCancel, rerunRouteOf } from "@/lib/jobs/operation";
import { redactJobRow } from "@/lib/jobs/redact-snapshot";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { query } from "@/lib/rpc/base";
import { jobsPageInput } from "@/lib/rpc/inputs/jobs";

// THE JOBS DOMAIN'S READS (ADR 0005 D1, #6121). The bodies live here, not in a `"use server"`
// module: each is a plain server function the procedures below serve over GET, and that the
// server-side callers (the assistant's read tools) call in-process.
//
// Every read applies `jobVisibleTo` (lib/jobs/visibility.ts): job visibility follows project
// visibility, so a reader who may not view a project sees none of its jobs here.

/**
 * The jobs page's server-side query (#578 — the console filter standard). Everything but the scope
 * and the window is a FILTER: optional, and enum-shaped values are narrowed to known members
 * before SQL.
 */
export interface JobsQuery {
	/** ISO bounds on created_at (inclusive). */
	from?: string;
	to?: string;
	authors?: string[];
	envs?: string[];
	projects?: string[];
	statuses?: string[];
	types?: string[];
	/** Free-text contains-match over project name/slug, environment + runner names, and
	 * the error message (jobs carry no commit/branch column to search). */
	search?: string;
	/**
	 * SCOPE, not a filter (lib/query/README.md, "Scope is a predicate, never a filter"): the project
	 * whose jobs list this is. It narrows the rows, the matched count, the facet counts and the
	 * total alike, so a project's list never offers or counts another project's jobs.
	 */
	projectId?: string;
	/** How many rows to return, newest first. Defaults to {@link JOBS_PAGE_SIZE}; capped at {@link JOBS_PAGE_MAX}. */
	limit?: number;
}

/** One facet option: value + display label + count over the UNFILTERED scope (the
 * standard: options never disappear as you select them). Label is null when the client
 * owns the labeling (statuses/types have static labels; authors resolve via members). */
export interface JobsFacetOption {
	value: string;
	label: string | null;
	count: number;
}

/** Narrow untrusted strings to known enum members (evidence-action precedent). */
function narrowTo<T extends string>(values: readonly T[], input?: string[]): T[] | undefined {
	if (!input?.length) return undefined;
	const known = new Set<string>(values);
	const kept = input.filter((v): v is T => known.has(v));
	return kept.length ? kept : undefined;
}

/** Parse an ISO bound; undefined when absent/invalid (an invalid bound must not 500). */
function parseBound(iso?: string): Date | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The refusal every by-id read gives for a job the reader cannot see — absent or not visible alike. */
function jobNotFound(): ActionRefusal {
	return new ActionRefusal("not-found", "Job not found.");
}

/** The window a read returns: the default for an absent or unusable `limit`, never above the cap. */
function pageLimit(limit?: number): number {
	if (limit === undefined || !Number.isFinite(limit) || limit < 1) return JOBS_PAGE_SIZE;
	return Math.min(Math.floor(limit), JOBS_PAGE_MAX);
}

/** A facet's running tally: each value's label and how many jobs in the scope carry it. */
type FacetTally = Map<string, { label: string | null; count: number }>;

/** Adds `count` jobs to `value`'s tally; a row the facet does not apply to (null) is skipped. */
function bump(tally: FacetTally, value: string | null, count: number, label: string | null = null): void {
	if (!value) return;
	const current = tally.get(value);
	if (current) current.count += count;
	else tally.set(value, { label, count });
}

/** A tally as facet options, sorted by label (falling back to the value). */
function asOptions(tally: FacetTally): JobsFacetOption[] {
	return [...tally.entries()]
		.map(([value, { label, count }]) => ({ value, label, count }))
		.sort((a, b) => (a.label ?? a.value).localeCompare(b.label ?? b.value));
}

/**
 * The jobs PAGE read (#578): one bounded window of rows filtered server-side in SQL, how many jobs
 * the filters match in all, facet counts, and the scope's true total.
 *
 * THREE PASSES, AND WHICH PREDICATES EACH ONE SEES IS THE POINT:
 *
 * | Pass | Scope (visibility, project) | Filters |
 * | --- | --- | --- |
 * | rows — newest first, at most `limit` | yes | yes |
 * | matched — the count the rows are a window of | yes | yes |
 * | facets — one `GROUP BY`, summed into every facet and into `total` | yes | **no** |
 *
 * The scope is the reader's visible jobs and, on a project's list, that project. Because the facet
 * pass sees the scope and nothing else, an option never disappears when it is picked, and a
 * project's list never counts or offers another project's jobs. `total === 0` therefore means
 * "this scope has no jobs at all", which is what tells first-run apart from a filter that matches
 * nothing.
 *
 * Nothing here is unbounded: the rows pass has a LIMIT, and the other two return counts — the
 * facet pass one row per distinct (status, type, author, project, environment), not one per job.
 */
export async function readJobsPage(q: JobsQuery = {}) {
	const actor = await authorize("view", { type: "job" });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const statuses = narrowTo(provisionJobStatus.enumValues, q.statuses);
		const types = narrowTo(provisionJobType.enumValues, q.types);
		const from = parseBound(q.from);
		const to = parseBound(q.to);
		const limit = pageLimit(q.limit);
		// Free-text search spans the joined display fields (project/env/runner) + the error
		// message — the columns a user actually recognises a job by. It is a filter: it narrows
		// the rows and the matched count, never the facet pass.
		const search = q.search?.trim();
		const like = search ? likeTerm(search) : undefined;
		// Built ONCE and handed to all three passes.
		const scope = and(visible, q.projectId ? eq(jobs.project_id, q.projectId) : undefined);
		const filtered = and(
			scope,
			from ? gte(jobs.created_at, from) : undefined,
			to ? lte(jobs.created_at, to) : undefined,
			q.authors?.length ? inArray(jobs.user_id, q.authors) : undefined,
			q.envs?.length ? inArray(jobs.environment_id, q.envs) : undefined,
			q.projects?.length ? inArray(jobs.project_id, q.projects) : undefined,
			statuses ? inArray(jobs.status, statuses) : undefined,
			types ? inArray(jobs.job_type, types) : undefined,
			like
				? or(
						ilike(projects.project_name, like),
						ilike(projects.slug, like),
						ilike(projectEnvironments.name, like),
						ilike(runners.name, like),
						ilike(jobs.error_message, like),
					)
				: undefined,
		);

		const [rows, matchedRows, facetRows] = await Promise.all([
			tx
				.select({
					job: jobs,
					project_name: projects.project_name,
					project_slug: projects.slug,
					runner_name: runners.name,
					runner_version: runners.version,
					cloud_provider: cloudIdentities.provider,
					cloud_identity_status: cloudIdentities.status,
					environment_name: projectEnvironments.name,
					environment_stage: projectEnvironments.stage,
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(runners, eq(jobs.runner_id, runners.id))
				.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
				.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
				.where(filtered)
				// `id` breaks ties, so two jobs created in the same instant keep one order from one
				// read to the next and a grown window never reshuffles the rows above it.
				.orderBy(desc(jobs.created_at), desc(jobs.id))
				.limit(limit),
			// The same joins as the rows pass: the search reads the joined names.
			tx
				.select({ matched: count() })
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(runners, eq(jobs.runner_id, runners.id))
				.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
				.where(filtered),
			// One grouped pass over the scope feeds every facet count and the total.
			tx
				.select({
					status: jobs.status,
					job_type: jobs.job_type,
					user_id: jobs.user_id,
					project_id: jobs.project_id,
					project_name: projects.project_name,
					environment_id: jobs.environment_id,
					environment_name: projectEnvironments.name,
					environment_stage: projectEnvironments.stage,
					jobs: count(),
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
				.where(scope)
				.groupBy(
					jobs.status,
					jobs.job_type,
					jobs.user_id,
					jobs.project_id,
					projects.project_name,
					jobs.environment_id,
					projectEnvironments.name,
					projectEnvironments.stage,
				),
		]);

		const authorF: FacetTally = new Map();
		const envF: FacetTally = new Map();
		const projectF: FacetTally = new Map();
		const statusF: FacetTally = new Map();
		const typeF: FacetTally = new Map();
		let total = 0;
		for (const r of facetRows) {
			total += r.jobs;
			bump(authorF, r.user_id, r.jobs);
			bump(
				envF,
				r.environment_id,
				r.jobs,
				r.environment_name
					? r.environment_stage
						? `${r.environment_name} (${r.environment_stage})`
						: r.environment_name
					: null,
			);
			bump(projectF, r.project_id, r.jobs, r.project_name);
			bump(statusF, r.status, r.jobs);
			bump(typeF, r.job_type, r.jobs);
		}

		return {
			rows: rows.map((r) => ({
				// Keeps the job-snapshot filter (lib/jobs/redact-snapshot.ts) on every user-facing row.
				...redactJobRow(r.job),
				project_name: r.project_name ?? null,
				project_slug: r.project_slug ?? null,
				runner_name: r.runner_name ?? null,
				runner_version: r.runner_version ?? null,
				cloud_provider: r.cloud_provider ?? null,
				cloud_identity_status: r.cloud_identity_status ?? null,
				environment_name: r.environment_name ?? null,
				environment_stage: r.environment_stage ?? null,
			})),
			/** How many jobs the filters match in this scope; `rows` is its newest `limit`. */
			matched: matchedRows[0]?.matched ?? 0,
			/** How many jobs the scope holds, whatever the filters. */
			total,
			facets: {
				authors: asOptions(authorF),
				envs: asOptions(envF),
				projects: asOptions(projectF),
				statuses: asOptions(statusF),
				types: asOptions(typeF),
			},
		};
	});
}

/**
 * One job by id, with its project's name and slug and its environment's name (the joins the list
 * uses), or null when there is no such job visible to the reader.
 */
export async function readJob(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({
				job: jobs,
				project_name: projects.project_name,
				project_slug: projects.slug,
				environment_name: projectEnvironments.name,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!row) return null;
		return {
			...redactJobRow(row.job),
			project_name: row.project_name ?? null,
			project_slug: row.project_slug ?? null,
			environment_name: row.environment_name ?? null,
		};
	});
}

/**
 * The request to deploy or destroy from a reviewed plan, as the plan's own page shows it: what was
 * asked for, where the request stands, and until when a person can still decide it. The requester's
 * note is deliberately not here — it is untrusted text and this page has no use for it.
 */
export interface JobApproval {
	operation: (typeof applyApprovals.$inferSelect)["operation"];
	status: (typeof applyApprovals.$inferSelect)["status"];
	requested_at: string;
	expires_at: string;
	decided_at: string | null;
	/** The job the approval started, once it has been used. */
	consumed_job_id: string | null;
}

/**
 * What the reader may do to a job from its page — the write side of permission-denied
 * (components/errors/manage-gate.ts): each answer is the question the write itself asks, so a
 * control is disabled with its reason instead of enabled and then refused.
 */
export interface JobControls {
	/** `cancelJob`: `edit` on the job, and the permission its operation takes on its target. */
	cancel: boolean;
	/** `rerunJob`: the project's plan or deploy permission, or `create` on the org's jobs for a copy. */
	rerun: boolean;
	/** `applyPlan`: `deploy` on the plan's project. */
	deploy: boolean;
}

/**
 * The reader's {@link JobControls} for one job: every question each control's write asks, put to
 * the PDP in one batch. A control whose target cannot be named, or that this kind of job does not
 * have, is false without a question.
 */
async function readJobControls(
	actor: Actor,
	job: Pick<typeof jobs.$inferSelect, "id" | "job_type" | "project_id" | "environment_id" | "config_snapshot">,
): Promise<JobControls> {
	const cancelTarget = permissionToCancel(job);
	const cancelChecks: BulkCheck[] | null =
		cancelTarget === null
			? [{ action: "edit", resource: { type: "job", id: job.id } }]
			: cancelTarget.id === null
				? null
				: [
						{ action: "edit", resource: { type: "job", id: job.id } },
						{ action: cancelTarget.action, resource: { type: cancelTarget.type, id: cancelTarget.id } },
					];
	const route = rerunRouteOf(job);
	const rerunChecks: BulkCheck[] | null =
		route.kind === "project"
			? [{ action: route.operation, resource: { type: "project", id: route.projectId } }]
			: route.kind === "copy"
				? [{ action: "create", resource: { type: "job" } }]
				: null;
	const deployChecks: BulkCheck[] | null =
		job.job_type === "PLAN" && job.project_id !== null
			? [{ action: "deploy", resource: { type: "project", id: job.project_id } }]
			: null;

	const groups = [cancelChecks, rerunChecks, deployChecks];
	const checks = groups.flatMap((group) => group ?? []);
	const decisions = checks.length === 0 ? [] : await getPdp().bulkCheck(actor, checks);
	// The decisions come back in the order asked; each group takes as many as it asked.
	let next = 0;
	const [cancel, rerun, deploy] = groups.map((group) => {
		if (group === null) return false;
		const answers = decisions.slice(next, next + group.length);
		next += group.length;
		return answers.length === group.length && answers.every((decision) => decision.allowed);
	});
	return { cancel: cancel === true, rerun: rerun === true, deploy: deploy === true };
}

/**
 * One job as its own PAGE reads it: {@link readJob}'s row, plus the two things only the page needs.
 *
 * - `can` — what this reader may do to the job ({@link JobControls}).
 * - `approval` — for a succeeded PLAN, the newest request to deploy or destroy from it, or null
 *   when nobody has asked. A request waits for a person for up to the organization's approval
 *   window (60 minutes by default), and the plan's page is where that wait is visible. Every other
 *   job reads `approval: null` without a query.
 *
 * Null when there is no such job visible to the reader. It is a separate reader, not more fields
 * on `readJob`, because `readJob` also answers the plan-apply action and the assistant's `get_job`,
 * neither of which has a use for a page's controls.
 */
export async function readJobDetail(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	const found = await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({
				job: jobs,
				project_name: projects.project_name,
				project_slug: projects.slug,
				environment_name: projectEnvironments.name,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!row) return null;
		let approval: JobApproval | null = null;
		if (row.job.job_type === "PLAN" && row.job.status === "SUCCESS") {
			// Reached only for a job the reader may see; the approval rows follow their plan (RLS).
			const [request] = await tx
				.select({
					operation: applyApprovals.operation,
					status: applyApprovals.status,
					created_at: applyApprovals.created_at,
					expires_at: applyApprovals.expires_at,
					decided_at: applyApprovals.decided_at,
					consumed_job_id: applyApprovals.consumed_job_id,
				})
				.from(applyApprovals)
				.where(eq(applyApprovals.plan_job_id, jobId))
				.orderBy(desc(applyApprovals.created_at))
				.limit(1);
			if (request) {
				approval = {
					operation: request.operation,
					status: request.status,
					requested_at: request.created_at.toISOString(),
					expires_at: request.expires_at.toISOString(),
					decided_at: request.decided_at?.toISOString() ?? null,
					consumed_job_id: request.consumed_job_id,
				};
			}
		}
		return { row, approval };
	});
	if (found === null) return null;
	// Asked of the row as stored: the target a permission names can sit in the snapshot.
	const can = await readJobControls(actor, found.row.job);
	return {
		...redactJobRow(found.row.job),
		project_name: found.row.project_name ?? null,
		project_slug: found.row.project_slug ?? null,
		environment_name: found.row.environment_name ?? null,
		approval: found.approval,
		can,
	};
}

/** A job as the detail page reads it (see {@link readJobDetail}). */
export type JobDetail = NonNullable<Awaited<ReturnType<typeof readJobDetail>>>;

/** A job's status and error message. Refuses (not-found) a job the reader cannot see. */
export async function readJobStatus(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({ status: jobs.status, error_message: jobs.error_message })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!row) throw jobNotFound();
		return row;
	});
}

/** A plan/deploy job's outcome and execution metadata. Refuses (not-found) a job the reader cannot see. */
export async function readPlanResult(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({
				status: jobs.status,
				job_type: jobs.job_type,
				error_message: jobs.error_message,
				execution_metadata: jobs.execution_metadata,
			})
			.from(jobs)
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!row) throw jobNotFound();
		return row;
	});
}

/** One project's jobs, newest first. Empty when the reader may not view the project's jobs. */
export async function readProjectJobs(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	const visible = await jobVisibleTo(actor);
	const rows = await withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) =>
		tx
			.select()
			.from(jobs)
			.where(and(eq(jobs.project_id, projectId), visible))
			.orderBy(desc(jobs.created_at)),
	);
	return rows.map(redactJobRow);
}

/** How many log lines the head read returns; the page's stream resumes after the last of them. */
const JOB_LOGS_HEAD_LIMIT = 2_000;

/** One log line as the detail page renders it — the head read and the SSE stream send this shape. */
export interface JobLogLine {
	id: number;
	log_chunk: string;
	stream_type: string;
	created_at: string;
}

/** The head of a job's log: its first lines, where they end, and whether they are the whole log so far. */
export interface JobLogsHead {
	lines: JobLogLine[];
	/** The id of the last line here; the stream resumes after it. Zero when there are none. */
	lastId: number;
	/**
	 * True when these lines are the job's whole log and nothing will be added: the job finished
	 * longer ago than twice the settle window (`JOB_LOG_SETTLE_MS`; twice, to cover the gap
	 * between this server's clock and the one that stamped `completed_at`) and the read came back
	 * under its limit. The page opens no stream for such a job. False means more may follow — the
	 * job is running, has only just finished, or has more lines than the head holds — and the
	 * stream fetches the rest.
	 */
	final: boolean;
}

/**
 * The first {@link JOB_LOGS_HEAD_LIMIT} log lines of a job, oldest first, so the detail page paints
 * its log on first load; the stream then resumes after `lastId`. Refuses (not-found) a job the
 * reader cannot see.
 */
export async function readJobLogsHead(jobId: string): Promise<JobLogsHead> {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [job] = await tx
			.select({ id: jobs.id, status: jobs.status, completed_at: jobs.completed_at })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!job) throw jobNotFound();
		const settled =
			JOB_FINISHED_STATUSES.has(job.status) &&
			job.completed_at != null &&
			Date.now() - job.completed_at.getTime() > 2 * JOB_LOG_SETTLE_MS;
		const rows = await tx
			.select({
				id: jobLogs.id,
				log_chunk: jobLogs.log_chunk,
				stream_type: jobLogs.stream_type,
				created_at: jobLogs.created_at,
			})
			.from(jobLogs)
			.where(eq(jobLogs.job_id, jobId))
			.orderBy(asc(jobLogs.id))
			.limit(JOB_LOGS_HEAD_LIMIT);
		const lines = rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
		return { lines, lastId: lines.at(-1)?.id ?? 0, final: settled && lines.length < JOB_LOGS_HEAD_LIMIT };
	});
}

/**
 * What `jobs.page` is asked: the filters and the range (`lib/rpc/inputs/jobs.ts`), plus the two
 * things that are not filters — the project whose list this is, and how many rows to return.
 */
export const jobsPageRead = jobsPageInput.extend({
	projectId: z.uuid().optional(),
	limit: z.number().int().min(1).max(JOBS_PAGE_MAX).optional(),
});

/** The validated shape of {@link jobsPageRead}. */
export type JobsPageRead = z.infer<typeof jobsPageRead>;

/**
 * Turns the wire input into the reader's query: a preset is resolved to concrete bounds
 * HERE, at read time, so "last 12 months" means the twelve months before this read.
 */
export function toJobsQuery(input: JobsPageRead, now: Date = new Date()): JobsQuery {
	const { range, ...filters } = input;
	const bounds =
		"preset" in range
			? (() => {
					const r = presetRange(range.preset, now);
					return { from: r.from.toISOString(), to: r.to.toISOString() };
				})()
			: range;
	return { ...filters, ...bounds };
}

/**
 * The readers the procedures below serve. The handlers call THROUGH this object, so a test of the
 * transport (tests/lib/rpc/route.test.ts) can stand in for the database without replacing the module.
 */
export const jobsReaders = {
	page: readJobsPage,
	detail: readJobDetail,
	status: readJobStatus,
	planResult: readPlanResult,
	logsHead: readJobLogsHead,
	project: readProjectJobs,
};

/** A job addressed by id. */
const byJob = z.object({ id: z.uuid() });

/**
 * The jobs domain's read procedures (ADR 0005 D1). Each is a GET; the actor comes from the request
 * address, bound by the `query` base.
 */
export const jobsRouter = {
	/** The jobs list page: a window of filtered rows, the matched count, facet counts, the total. */
	page: query.input(jobsPageRead).handler(({ input }) => jobsReaders.page(toJobsQuery(input))),
	/** One job as its page reads it: names, the reader's controls, a plan's approval; null when not visible. */
	detail: query.input(byJob).handler(({ input }) => jobsReaders.detail(input.id)),
	/** A job's status and error. */
	status: query.input(byJob).handler(({ input }) => jobsReaders.status(input.id)),
	/** A plan/deploy job's outcome. */
	planResult: query.input(byJob).handler(({ input }) => jobsReaders.planResult(input.id)),
	/** The head of a job's log, for first paint. */
	logsHead: query.input(byJob).handler(({ input }) => jobsReaders.logsHead(input.id)),
	/** One project's jobs. */
	project: query
		.input(z.object({ projectId: z.uuid() }))
		.handler(({ input }) => jobsReaders.project(input.projectId)),
};
