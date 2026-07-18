"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize } from "@/lib/authz/guard";
import { signedJob } from "@/lib/db/signed-job";
import { withOwnerScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { likeTerm } from "@/lib/db/like";
import { newTraceparent } from "@/lib/observability/trace";
import { notifyRunnerCancel } from "@/lib/runners/cancel-signal";
import { notifyScaler } from "@/lib/scaler";
import { provisionJobStatus, provisionJobType } from "@/lib/db/schema/enums";
import { and, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";

export async function getJobStatus(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({ status: jobs.status, error_message: jobs.error_message })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!row) throw new Error("Failed to get job status");
		return row;
	});
}

/** Fetches a single job (owner-scoped) by id, or null. */
export async function getJob(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select()
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		return row ?? null;
	});
}

/** Fetches all jobs with project project_name and runner name joined. */
export async function getJobs() {
	const actor = await authorize("view", { type: "job" });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const rows = await tx
			.select({
				job: jobs,
				project_name: projects.project_name,
				project_slug: projects.slug,
				runner_name: runners.name,
				cloud_provider: cloudIdentities.provider,
				environment_name: projectEnvironments.name,
				environment_stage: projectEnvironments.stage,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(runners, eq(jobs.runner_id, runners.id))
			.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				projectEnvironments,
				eq(jobs.environment_id, projectEnvironments.id),
			)
			.orderBy(desc(jobs.created_at));

		return rows.map((r) => ({
			...r.job,
			project_name: r.project_name ?? null,
			project_slug: r.project_slug ?? null,
			runner_name: r.runner_name ?? null,
			cloud_provider: r.cloud_provider ?? null,
			environment_name: r.environment_name ?? null,
			environment_stage: r.environment_stage ?? null,
		}));
	});
}

/** A job row enriched with joined project/runner/provider display fields (from getJobs). */
export type JobWithMeta = Awaited<ReturnType<typeof getJobs>>[number];

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
function narrowTo<T extends string>(
	values: readonly T[],
	input?: string[],
): T[] | undefined {
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

/**
 * The jobs PAGE query (#578): rows filtered server-side in SQL + facet counts over the
 * unfiltered universe + the true total. The unfiltered `getJobs()` (and its shared
 * `qk.jobs(org)` cache: command palette, breadcrumbs, overview, runners, plan flow)
 * stays untouched — this is the page's own parameterized read.
 */
export async function getJobsPage(query: JobsQuery = {}) {
	const actor = await authorize("view", { type: "job" });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const statuses = narrowTo(provisionJobStatus.enumValues, query.statuses);
		const types = narrowTo(provisionJobType.enumValues, query.types);
		const from = parseBound(query.from);
		const to = parseBound(query.to);
		// Free-text search spans the joined display fields (project/env/runner) + the error
		// message — the columns a user actually recognises a job by. It narrows the ROWS
		// query only; the facet pass stays unfiltered (counts over the whole universe).
		const search = query.search?.trim();
		const like = search ? likeTerm(search) : undefined;
		const conditions = [
			from ? gte(jobs.created_at, from) : undefined,
			to ? lte(jobs.created_at, to) : undefined,
			query.authors?.length ? inArray(jobs.user_id, query.authors) : undefined,
			query.envs?.length ? inArray(jobs.environment_id, query.envs) : undefined,
			query.projects?.length ? inArray(jobs.project_id, query.projects) : undefined,
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
					cloud_provider: cloudIdentities.provider,
					environment_name: projectEnvironments.name,
					environment_stage: projectEnvironments.stage,
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(runners, eq(jobs.runner_id, runners.id))
				.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
				.leftJoin(
					projectEnvironments,
					eq(jobs.environment_id, projectEnvironments.id),
				)
				.where(conditions.length ? and(...conditions) : undefined)
				.orderBy(desc(jobs.created_at)),
			// One light pass over the whole (RLS-scoped) universe feeds every facet count —
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
				.leftJoin(
					projectEnvironments,
					eq(jobs.environment_id, projectEnvironments.id),
				),
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
		const asOptions = (
			m: Map<string, { label: string | null; count: number }>,
		): JobsFacetOption[] =>
			[...m.entries()]
				.map(([value, { label, count }]) => ({ value, label, count }))
				.sort((a, b) => (a.label ?? a.value).localeCompare(b.label ?? b.value));

		return {
			rows: rows.map((r) => ({
				...r.job,
				project_name: r.project_name ?? null,
				project_slug: r.project_slug ?? null,
				runner_name: r.runner_name ?? null,
				cloud_provider: r.cloud_provider ?? null,
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

/** The jobs page payload (rows + unfiltered facet counts + true total). */
export type JobsPage = Awaited<ReturnType<typeof getJobsPage>>;

export async function getPlanResult(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [row] = await tx
			.select({
				status: jobs.status,
				job_type: jobs.job_type,
				error_message: jobs.error_message,
				execution_metadata: jobs.execution_metadata,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!row) throw new Error("Failed to get plan result");
		return row;
	});
}

export async function getProjectJobs(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		return tx
			.select()
			.from(jobs)
			.where(eq(jobs.project_id, projectId))
			.orderBy(desc(jobs.created_at));
	});
}

export async function rerunJob(jobId: string) {
	const actor = await authorize("create", { type: "job" });
	await assertUsageAllowed(actor.orgId);
	const owner = actor.userId;
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [original] = await tx
			.select({
				job_type: jobs.job_type,
				config_snapshot: jobs.config_snapshot,
				cloud_identity_id: jobs.cloud_identity_id,
				project_id: jobs.project_id,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!original) throw new Error("Original job not found");

		const [newJob] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: owner,
				org_id: actor.orgId,
				job_type: original.job_type,
				config_snapshot: original.config_snapshot,
				cloud_identity_id: original.cloud_identity_id,
				project_id: original.project_id,
				status: "QUEUED",
				// A rerun is a fresh operation → a new trace root (not the original's).
				traceparent: newTraceparent(),
			}))
			.returning({ id: jobs.id });

		notifyScaler();
		return newJob;
	});
}

/**
 * Cancels a queued, claimed, or processing job. Flips the DB to CANCELLED and, when the job
 * is already running on a runner (CLAIMED/PROCESSING with a runner_id), SIGNALS that runner
 * to tear it down mid-flight — the runner SIGINTs the in-flight `tofu apply` so it finishes
 * the current resource, writes state, and releases the state lock (a clean stop), then
 * re-posts CANCELLED (with an orphan-risk flag if the apply had started). A QUEUED job has no
 * runner yet, so it stays a pure DB flip (claim_next_job never claims a CANCELLED job).
 */
export async function cancelJob(jobId: string) {
	const actor = await authorize("edit", { type: "job", id: jobId });
	const owner = actor.userId;
	const signal = await withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [job] = await tx
			.select({ status: jobs.status, runner_id: jobs.runner_id })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) throw new Error("Job not found");

		const cancellable = ["QUEUED", "CLAIMED", "PROCESSING"];
		if (!cancellable.includes(job.status)) {
			throw new Error(`Cannot cancel job with status ${job.status}`);
		}

		await tx
			.update(jobs)
			.set({
				status: "CANCELLED",
				error_message: "Cancelled by user",
				completed_at: new Date(),
			})
			.where(eq(jobs.id, jobId));

		// A running job (claimed by a runner) must be torn down mid-flight, not just flipped
		// in the DB. Return the runner to signal AFTER the transaction commits.
		return job.runner_id && (job.status === "CLAIMED" || job.status === "PROCESSING")
			? job.runner_id
			: null;
	});

	// Fire-and-forget: signal the owning runner to abort the in-flight tofu run. The DB is
	// already CANCELLED, so a delivery failure only means the runner's job runs to its
	// natural end (or the 2h timeout) — never a failed cancel.
	if (signal) {
		await notifyRunnerCancel(signal, jobId).catch(() => {});
	}
}

/**
 * Record an authorized, time-boxed verification override on a QUEUED deploy job
 * (elench). The runner reads `jobs.verify_override` and passes it to the
 * fail-closed gate so a deliberate, accountable waiver can let an apply proceed
 * despite a failing control — disabling the gate wholesale is never an option.
 * `by` is stamped server-side to the authorizing actor; the waiver expires after
 * `ttlHours` (default 24). Requires edit authority on the job.
 */
export async function recordVerifyOverride(
	jobId: string,
	controls: string[],
	reason: string,
	ttlHours = 24,
) {
	if (controls.length === 0) {
		throw new Error("At least one control id is required to record an override");
	}
	if (!reason.trim()) {
		throw new Error("A reason is required for a verification override");
	}
	const actor = await authorize("edit", { type: "job", id: jobId });
	const owner = actor.userId;
	const expiry = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const [job] = await tx
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!job) throw new Error("Job not found");
		if (job.status !== "QUEUED") {
			throw new Error(
				`A verification override can only be set on a QUEUED job (status ${job.status})`,
			);
		}
		await tx
			.update(jobs)
			.set({
				verify_override: {
					controls,
					reason: reason.trim(),
					by: actor.userId,
					expiry,
				},
			})
			.where(eq(jobs.id, jobId));
	});
}
