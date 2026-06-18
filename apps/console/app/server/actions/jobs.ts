"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import { cloudIdentities, jobs, runners, specs } from "@/lib/db/schema";
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

/** Fetches all jobs with spec project_name and runner name joined. */
export async function getJobs() {
	const actor = await authorize("view", { type: "job" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const rows = await tx
			.select({
				job: jobs,
				vine_name: specs.project_name,
				vine_vineyard_id: specs.zone_id,
				worker_name: runners.name,
				cloud_provider: cloudIdentities.provider,
			})
			.from(jobs)
			.leftJoin(specs, eq(jobs.spec_id, specs.id))
			.leftJoin(runners, eq(jobs.runner_id, runners.id))
			.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
			.orderBy(desc(jobs.created_at));

		return rows.map((r) => ({
			...r.job,
			vine_name: r.vine_name ?? null,
			vine_vineyard_id: r.vine_vineyard_id ?? null,
			worker_name: r.worker_name ?? null,
			cloud_provider: r.cloud_provider ?? null,
		}));
	});
}

/** A job row enriched with joined spec/runner/provider display fields (from getJobs). */
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

export async function getVineJobs(vineId: string) {
	const actor = await authorize("view", { type: "spec", id: vineId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		return tx
			.select()
			.from(jobs)
			.where(eq(jobs.spec_id, vineId))
			.orderBy(desc(jobs.created_at));
	});
}

export async function rerunJob(jobId: string) {
	const actor = await authorize("create", { type: "job" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [original] = await tx
			.select({
				job_type: jobs.job_type,
				config_snapshot: jobs.config_snapshot,
				cloud_identity_id: jobs.cloud_identity_id,
				zone_id: jobs.zone_id,
				spec_id: jobs.spec_id,
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
				zone_id: original.zone_id,
				spec_id: original.spec_id,
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
