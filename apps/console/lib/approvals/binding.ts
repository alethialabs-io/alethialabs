// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What an approval is bound to, and whether that binding still describes the environment.
//
// An approval names a plan job and that plan's digest. It stays good only while the plan is still the
// thing that would run: the named PLAN job succeeded with exactly the approved digest, it is the kind
// of plan the operation runs, no build, deploy or destroy of the environment was queued after it, and
// no newer plan of the same kind succeeded.
//
// - DEPLOY — bound to an apply plan (`destroy_plan` false).
// - DESTROY — bound to a destroy-mode plan (`destroy_plan` true, #7455): the teardown itself, planned
//   with `tofu plan -destroy`, which the destroy then applies and nothing else. Until #7455 a destroy
//   was bound to the plan the environment's latest successful DEPLOY applied; that binding is gone,
//   so an approval recorded under it no longer names a destroy plan and reads as `plan_changed`.
//
// Read by the queue gate (gate.ts) when an approval is consumed, by request.ts when one is created and
// by decide.ts / read.ts when one is shown or decided, so all four agree on "still current".

import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { planDigestOf } from "./plan-binding";
import type { ApplyOperation } from "./types";

/** A database handle or a transaction: every read here works on either. */
export type Executor = Db | Tx;

/** The job types whose queueing moves the environment past a plan or an applied state. */
const RUN_JOB_TYPES = ["BUILD", "DEPLOY", "DESTROY"] as const;

/** The fields of an approval its binding is checked from. */
export interface ApprovalBinding {
	environment_id: string;
	operation: ApplyOperation;
	plan_job_id: string;
	plan_sha256: string;
}

/** Why a binding no longer holds. Every value makes the approval `superseded`. */
export type BindingStaleReason =
	/** The plan job is gone, has not succeeded, is not the kind of plan the operation runs, or its digest is not the approved one. */
	| "plan_changed"
	/** A build, deploy or destroy of the environment was queued after the plan. */
	| "run_since_plan"
	/** A newer plan of the same kind succeeded for the environment. */
	| "newer_plan";

/** The sentence each {@link BindingStaleReason} is shown as, for the operation the approval is for. */
export function staleMessage(reason: BindingStaleReason, operation: ApplyOperation = "deploy"): string {
	const plan = operation === "destroy" ? "destroy plan" : "plan";
	switch (reason) {
		case "plan_changed":
			return `The approved ${plan} is no longer the ${plan} on record for this environment. Run a new ${plan} and request a new approval.`;
		case "run_since_plan":
			return `Something was built, deployed or destroyed on this environment after the approved ${plan}. Run a new ${plan} and request a new approval.`;
		case "newer_plan":
			return `A newer ${plan} of this environment succeeded after the approved one. Request an approval for the newer ${plan}.`;
	}
}

/** The latest successful DEPLOY of an environment and the reviewed plan it applied, or null. */
export async function appliedState(
	db: Executor,
	environmentId: string,
): Promise<{ deployJobId: string; planJobId: string | null; planSha256: string | null; createdAt: Date } | null> {
	const [row] = await db
		.select({
			id: jobs.id,
			plan_job_id: jobs.plan_job_id,
			plan_sha256: jobs.plan_sha256,
			created_at: jobs.created_at,
		})
		.from(jobs)
		.where(and(eq(jobs.environment_id, environmentId), eq(jobs.job_type, "DEPLOY"), eq(jobs.status, "SUCCESS")))
		.orderBy(desc(jobs.created_at))
		.limit(1);
	if (!row) return null;
	return { deployJobId: row.id, planJobId: row.plan_job_id, planSha256: row.plan_sha256, createdAt: row.created_at };
}

/** True when a build, deploy or destroy of the environment was queued after `since`, `excludeJobId` aside. */
async function runQueuedSince(db: Executor, environmentId: string, since: Date, excludeJobId?: string): Promise<boolean> {
	const [later] = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, environmentId),
				inArray(jobs.job_type, [...RUN_JOB_TYPES]),
				gt(jobs.created_at, since),
				...(excludeJobId ? [ne(jobs.id, excludeJobId)] : []),
			),
		)
		.limit(1);
	return Boolean(later);
}

/**
 * Null while `approval`'s binding still describes its environment, else why not. `excludeJobId` is the
 * job being queued against it right now, in the same transaction, which is not a run "since".
 *
 * The plan's kind is part of the binding: a deploy approval naming a destroy plan, or a destroy
 * approval naming an apply plan, is `plan_changed` — never current.
 */
export async function bindingStaleReason(
	db: Executor,
	approval: ApprovalBinding,
	excludeJobId?: string,
): Promise<BindingStaleReason | null> {
	const destroyPlan = approval.operation === "destroy";
	const [plan] = await db
		.select({
			status: jobs.status,
			created_at: jobs.created_at,
			plan_sha256: jobs.plan_sha256,
			execution_metadata: jobs.execution_metadata,
			destroy_plan: jobs.destroy_plan,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.id, approval.plan_job_id),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.environment_id, approval.environment_id),
			),
		)
		.limit(1);
	if (
		!plan ||
		plan.status !== "SUCCESS" ||
		plan.destroy_plan !== destroyPlan ||
		planDigestOf(plan) !== approval.plan_sha256
	) {
		return "plan_changed";
	}
	if (await runQueuedSince(db, approval.environment_id, plan.created_at, excludeJobId)) return "run_since_plan";
	const [newer] = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, approval.environment_id),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.destroy_plan, destroyPlan),
				eq(jobs.status, "SUCCESS"),
				gt(jobs.created_at, plan.created_at),
			),
		)
		.limit(1);
	return newer ? "newer_plan" : null;
}

/**
 * The environment's latest succeeded destroy plan, when it is still current (nothing built, deployed
 * or destroyed since, and no newer destroy plan), else null. What a destroy approval is requested
 * against when the caller names an environment rather than a plan (the agents' destroy tools).
 */
export async function currentDestroyPlan(db: Executor, environmentId: string): Promise<{ planJobId: string } | null> {
	const [plan] = await db
		.select({ id: jobs.id, created_at: jobs.created_at })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, environmentId),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.destroy_plan, true),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);
	if (!plan) return null;
	if (await runQueuedSince(db, environmentId, plan.created_at)) return null;
	return { planJobId: plan.id };
}
