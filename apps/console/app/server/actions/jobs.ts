"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs domain's server actions. Its reads (the list page, one job, its status, its plan result,
// its log head, one project's jobs) are GET procedures in lib/rpc/procedures/jobs.ts (#6121);
// what stays here is the unfiltered list the shell reads, and the writes.

import { z } from "zod";
import { tryDestroyProject, tryPlanProject, tryProvisionProject } from "@/app/server/actions/projects";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { signedJob } from "@/lib/db/signed-job";
import { projectOrgRefusal } from "@/lib/projects/project-org";
import { withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { assertUsageAllowed, UsageLimitError } from "@/lib/billing/usage-guard";
import { cancelJobAs } from "@/lib/jobs/cancel";
import { rerunRouteOf } from "@/lib/jobs/operation";
import { redactJobRow } from "@/lib/jobs/redact-snapshot";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { snapshotWithoutRunnerToken } from "@/lib/runners/lifecycle-token";
import { newTraceparent } from "@/lib/observability/trace";
import { readJob } from "@/lib/rpc/procedures/jobs";
import { notifyScaler } from "@/lib/scaler";
import { and, desc, eq } from "drizzle-orm";

/** Fetches every job visible to the reader, with project, runner, provider and environment joined. */
export async function getJobs() {
	const actor = await authorize("view", { type: "job" });
	const owner = actor.userId;
	// Job visibility follows project visibility (lib/jobs/visibility.ts), as in every jobs read.
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: owner, orgId: actor.orgId }, async (tx) => {
		const rows = await tx
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
			.leftJoin(
				projectEnvironments,
				eq(jobs.environment_id, projectEnvironments.id),
			)
			.where(visible)
			.orderBy(desc(jobs.created_at));

		return rows.map((r) => ({
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
		}));
	});
}

/** A job row enriched with joined project/runner/provider display fields (from getJobs). */
export type JobWithMeta = Awaited<ReturnType<typeof getJobs>>[number];

/**
 * The usage cap and the daily job quota, refused as the plan gate they are: their message names the
 * way out (wait, or upgrade) and is shown as written.
 */
async function refuseOverUsage(orgId: string): Promise<void> {
	try {
		await assertUsageAllowed(orgId);
		await assertJobQuotaAllowed(orgId);
	} catch (error) {
		if (error instanceof UsageLimitError) throw new ActionRefusal("entitlement", error.message, "usage");
		throw error;
	}
}

/**
 * Runs a job again (see lib/jobs/operation.ts for the rule).
 *
 * - A project's plan, deploy or destroy runs again through the entry point a fresh run uses
 *   (`tryPlanProject` / `tryProvisionProject` / `tryDestroyProject`) against the same project and
 *   environment: the project permission for that operation, the one-job-in-flight guard on the
 *   environment, the queue-time gates and the project's current configuration all come from there.
 * - A job with no project is re-queued as a copy of itself under the org's job permission.
 * - Any other project job is refused with a sentence that says where to run it again.
 *
 * Only a job of the actor's active org can be re-run, and a job the reader cannot see (job visibility
 * follows project visibility) is not found.
 */
async function rerun(jobId: string): Promise<{ id: string }> {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	const [original] = await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.select({
				job_type: jobs.job_type,
				config_snapshot: jobs.config_snapshot,
				cloud_identity_id: jobs.cloud_identity_id,
				project_id: jobs.project_id,
				environment_id: jobs.environment_id,
				org_id: jobs.org_id,
				project_org_id: projects.org_id,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1),
	);

	if (!original) throw new ActionRefusal("not-found", "Job not found.");
	if (original.org_id !== actor.orgId) {
		throw new ActionRefusal(
			"conflict",
			original.org_id === actor.userId
				? "This job belongs to your personal workspace — switch to it to run this."
				: "This job belongs to another organization — switch to it to run this.",
		);
	}

	const route = rerunRouteOf(original);
	if (route.kind === "refuse") throw new ActionRefusal("conflict", route.reason);
	if (route.kind === "project") {
		if (original.project_org_id === null) throw new ActionRefusal("not-found", "Project not found.");
		const refusal = projectOrgRefusal(original.project_org_id, actor);
		if (refusal) throw new ActionRefusal("conflict", refusal);
		const result =
			route.operation === "plan"
				? await tryPlanProject(route.projectId, null, route.environmentId)
				: route.operation === "deploy"
					? await tryProvisionProject(route.projectId, undefined, null, route.environmentId)
					: await tryDestroyProject(route.projectId, route.environmentId, null);
		if (!result.ok) throw new ActionRefusal("conflict", result.error);
		return { id: result.jobId };
	}

	// A job with no project: a copy of itself, under the org's permission to create jobs.
	await authorize("create", { type: "job" });
	await refuseOverUsage(actor.orgId);
	const [copy] = await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				org_id: actor.orgId,
				job_type: original.job_type,
				initiated_by: "user",
				config_snapshot: snapshotWithoutRunnerToken(original.config_snapshot),
				cloud_identity_id: original.cloud_identity_id,
				status: "QUEUED",
				// A rerun is a fresh operation → a new trace root (not the original's).
				traceparent: newTraceparent(),
			}))
			.returning({ id: jobs.id }),
	);
	notifyScaler();
	return copy;
}

/** A job addressed by id, as the client sends it. */
const jobInput = z.object({ jobId: z.uuid() });

/**
 * {@link rerun} through the mutation contract: refusals come back as values, never as digests.
 * A `"use server"` file exports only async functions, so the contract is applied inside one.
 */
export async function rerunJob(raw: z.input<typeof jobInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({ input: jobInput, run: ({ input }) => rerun(input.jobId) })(raw);
}

/**
 * Cancels a queued, claimed or processing job, through the one cancel both the console and the CLI
 * use (lib/jobs/cancel.ts): the job read as this actor (RLS and job visibility), the permission its
 * operation takes on its target, a conditional flip, and the runner signalled when the job it
 * flipped had been claimed — the runner SIGINTs the in-flight `tofu apply` so it finishes the current
 * resource, writes state and releases the state lock, then re-posts CANCELLED.
 */
async function cancel(jobId: string): Promise<null> {
	const actor = await authorize("edit", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	const outcome = await cancelJobAs(actor, jobId, visible, (work) =>
		withScope({ ownerId: actor.userId, orgId: actor.orgId }, work),
	);
	switch (outcome.kind) {
		case "cancelled":
			return null;
		case "not-found":
			throw new ActionRefusal("not-found", "Job not found.");
		case "no-target":
			throw new ActionRefusal("not-found", "This job's runner or project no longer exists, so it can't be cancelled here.");
		case "not-cancellable":
			throw new ActionRefusal(
				"conflict",
				`This job is ${outcome.status.toLowerCase()} — only a queued or running job can be cancelled.`,
			);
	}
}

/** {@link cancel} through the mutation contract. */
export async function cancelJob(raw: z.input<typeof jobInput>): Promise<ActionResult<null>> {
	return defineAction({ input: jobInput, run: ({ input }) => cancel(input.jobId) })(raw);
}

/** A plan job to apply, and the runner the user picked (null: any runner). */
const applyInput = z.object({
	planJobId: z.uuid(),
	runnerId: z.string().min(1).max(200).nullable(),
});

/**
 * Applies a successful PLAN: queues the deploy of exactly that plan, against the project AND THE
 * ENVIRONMENT the plan ran for — both read from the plan job on the server, never taken from the
 * client. Without the environment the deploy went to the project's default environment, whatever
 * environment the reviewed plan was of. A refusal the user can act on (no cloud account, a job
 * already in flight, the usage cap) comes back as its own sentence.
 */
export async function applyPlan(raw: z.input<typeof applyInput>): Promise<ActionResult<{ jobId: string }>> {
	return defineAction({ input: applyInput, run: ({ input }) => apply(input.planJobId, input.runnerId) })(raw);
}

/** The body of {@link applyPlan}: the plan job is read (visibility-aware), then deployed as reviewed. */
async function apply(planJobId: string, runnerId: string | null): Promise<{ jobId: string }> {
	const plan = await readJob(planJobId);
	if (!plan) throw new ActionRefusal("not-found", "Job not found.");
	if (plan.job_type !== "PLAN" || plan.status !== "SUCCESS" || !plan.project_id) {
		throw new ActionRefusal("conflict", "Only a successful plan of a project can be applied.");
	}
	const result = await tryProvisionProject(plan.project_id, plan.id, runnerId, plan.environment_id);
	if (!result.ok) throw new ActionRefusal("conflict", result.error);
	return { jobId: result.jobId };
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
