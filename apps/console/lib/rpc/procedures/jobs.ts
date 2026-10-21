// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { presetRange } from "@repo/ui/range";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import { z } from "zod";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	cloudIdentities,
	jobLogs,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { provisionJobStatus, provisionJobType } from "@/lib/db/schema/enums";
import { redactJobRow } from "@/lib/jobs/redact-snapshot";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { query } from "@/lib/rpc/base";
import { type JobsPageInput, jobsPageInput } from "@/lib/rpc/inputs/jobs";

// THE JOBS DOMAIN'S READS (ADR 0005 D1, #6121). The bodies live here, not in a `"use server"`
// module: each is a plain server function the procedures below serve over GET, and that the
// server-side callers (the assistant's read tools) call in-process.
//
// Every read applies `jobVisibleTo` (lib/jobs/visibility.ts): job visibility follows project
// visibility, so a reader who may not view a project sees none of its jobs here.

/** The jobs page's server-side filter query (#578 — the console filter standard). All
 * fields optional; enum-shaped values are narrowed to known members before SQL. */
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
}

/** One facet option: value + display label + count over the UNFILTERED org universe (the
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

/**
 * The jobs PAGE read (#578): rows filtered server-side in SQL + facet counts over the
 * unfiltered universe + the true total. "Unfiltered" means unfiltered by the page's own
 * filters; both passes see only the jobs visible to the reader.
 */
export async function readJobsPage(q: JobsQuery = {}) {
	const actor = await authorize("view", { type: "job" });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const statuses = narrowTo(provisionJobStatus.enumValues, q.statuses);
		const types = narrowTo(provisionJobType.enumValues, q.types);
		const from = parseBound(q.from);
		const to = parseBound(q.to);
		// Free-text search spans the joined display fields (project/env/runner) + the error
		// message — the columns a user actually recognises a job by. It narrows the ROWS
		// query only; the facet pass stays unfiltered (counts over the whole universe).
		const search = q.search?.trim();
		const like = search ? likeTerm(search) : undefined;
		const conditions = [
			visible,
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
		].filter((c) => c !== undefined);

		const [rows, facetRows] = await Promise.all([
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
				.where(and(...conditions))
				.orderBy(desc(jobs.created_at)),
			// One light pass over the whole visible universe feeds every facet count —
			// aggregated here rather than N GROUP BYs (the evidence-action precedent).
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
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
				.where(visible),
		]);

		const bump = (
			m: Map<string, { label: string | null; count: number }>,
			value: string | null,
			label: string | null = null,
		) => {
			if (!value) return;
			const cur = m.get(value);
			if (cur) cur.count += 1;
			else m.set(value, { label, count: 1 });
		};
		const authorF = new Map<string, { label: string | null; count: number }>();
		const envF = new Map<string, { label: string | null; count: number }>();
		const projectF = new Map<string, { label: string | null; count: number }>();
		const statusF = new Map<string, { label: string | null; count: number }>();
		const typeF = new Map<string, { label: string | null; count: number }>();
		for (const r of facetRows) {
			bump(authorF, r.user_id);
			bump(
				envF,
				r.environment_id,
				r.environment_name
					? r.environment_stage
						? `${r.environment_name} (${r.environment_stage})`
						: r.environment_name
					: null,
			);
			bump(projectF, r.project_id, r.project_name);
			bump(statusF, r.status);
			bump(typeF, r.job_type);
		}
		const asOptions = (m: Map<string, { label: string | null; count: number }>): JobsFacetOption[] =>
			[...m.entries()]
				.map(([value, { label, count }]) => ({ value, label, count }))
				.sort((a, b) => (a.label ?? a.value).localeCompare(b.label ?? b.value));

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
			total: facetRows.length,
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

/** A job as the detail page reads it (see {@link readJob}). */
export type JobDetail = NonNullable<Awaited<ReturnType<typeof readJob>>>;

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

/**
 * The first {@link JOB_LOGS_HEAD_LIMIT} log lines of a job, oldest first, so the detail page paints
 * its log on first load; the live stream then resumes after `lastId`. Refuses (not-found) a job the
 * reader cannot see.
 */
export async function readJobLogsHead(jobId: string): Promise<{ lines: JobLogLine[]; lastId: number }> {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [job] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!job) throw jobNotFound();
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
		return { lines, lastId: lines.at(-1)?.id ?? 0 };
	});
}

/**
 * Turns the wire input into the reader's query: a preset is resolved to concrete bounds
 * HERE, at read time, so "last 12 months" means the twelve months before this read.
 */
export function toJobsQuery(input: JobsPageInput, now: Date = new Date()): JobsQuery {
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
	detail: readJob,
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
	/** The jobs list page: filtered rows, facet counts, total. */
	page: query.input(jobsPageInput).handler(({ input }) => jobsReaders.page(toJobsQuery(input))),
	/** One job, with its project and environment names; null when it is not visible. */
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
