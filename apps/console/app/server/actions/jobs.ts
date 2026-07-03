"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { notifyScaler } from "@/lib/scaler";
import { desc, eq } from "drizzle-orm";

export async function getJobStatus(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
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
	return withOwnerScope(owner, async (tx) => {
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
	return withOwnerScope(owner, async (tx) => {
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

export async function getPlanResult(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.select({
				status: jobs.status,
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
	return withOwnerScope(owner, async (tx) => {
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
	return withOwnerScope(owner, async (tx) => {
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
			.values({
				user_id: owner,
				job_type: original.job_type,
				config_snapshot: original.config_snapshot,
				cloud_identity_id: original.cloud_identity_id,
				project_id: original.project_id,
				status: "QUEUED",
			})
			.returning({ id: jobs.id });

		notifyScaler();
		return newJob;
	});
}

/** Cancels a queued, claimed, or processing job. */
export async function cancelJob(jobId: string) {
	const actor = await authorize("edit", { type: "job", id: jobId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.select({ status: jobs.status })
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
	});
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
	return withOwnerScope(owner, async (tx) => {
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
