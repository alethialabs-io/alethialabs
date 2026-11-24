// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What an approval is bound to, and whether that binding still describes the environment.
//
// An approval names a plan job and that plan's digest. It stays good only while the plan is still the
// thing that would run:
//
// - DEPLOY — the named PLAN job succeeded with exactly the approved digest, no build, deploy or destroy
//   of the environment was queued after it, and no newer plan of the environment succeeded.
// - DESTROY — bound to the state the destroy tears down: the reviewed plan that the environment's
//   latest successful DEPLOY applied. It stays good while that DEPLOY is still the latest thing that
//   ran on the environment. (A destroy-mode plan, which would let the approver read the teardown
//   itself, is not something the console queues yet; when it is, it replaces this binding.)
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
	/** The plan job is gone, has not succeeded, or its digest is not the approved one. */
	| "plan_changed"
	/** A build, deploy or destroy of the environment was queued after the plan. */
	| "run_since_plan"
	/** A newer plan of the environment succeeded. */
	| "newer_plan"
	/** For a destroy: the environment's applied state is no longer the one approved. */
	| "state_moved";

/** The sentence each {@link BindingStaleReason} is shown as. */
export function staleMessage(reason: BindingStaleReason): string {
	switch (reason) {
		case "plan_changed":
			return "The approved plan is no longer the plan on record for this environment. Plan again and request a new approval.";
		case "run_since_plan":
			return "Something was built, deployed or destroyed on this environment after the approved plan. Plan again and request a new approval.";
		case "newer_plan":
			return "A newer plan of this environment succeeded after the approved one. Request an approval for the newer plan.";
		case "state_moved":
			return "This environment changed after the destroy was approved. Request a new approval for its current state.";
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
 */
export async function bindingStaleReason(
	db: Executor,
	approval: ApprovalBinding,
	excludeJobId?: string,
): Promise<BindingStaleReason | null> {
	if (approval.operation === "destroy") {
		const applied = await appliedState(db, approval.environment_id);
		if (!applied || applied.planJobId !== approval.plan_job_id || applied.planSha256 !== approval.plan_sha256) {
			return "state_moved";
		}
		return (await runQueuedSince(db, approval.environment_id, applied.createdAt, excludeJobId)) ? "state_moved" : null;
	}

	const [plan] = await db
		.select({
			status: jobs.status,
			created_at: jobs.created_at,
			plan_sha256: jobs.plan_sha256,
			execution_metadata: jobs.execution_metadata,
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
	if (!plan || plan.status !== "SUCCESS" || planDigestOf(plan) !== approval.plan_sha256) return "plan_changed";
	if (await runQueuedSince(db, approval.environment_id, plan.created_at, excludeJobId)) return "run_since_plan";
	const [newer] = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, approval.environment_id),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.status, "SUCCESS"),
				gt(jobs.created_at, plan.created_at),
			),
		)
		.limit(1);
	return newer ? "newer_plan" : null;
}
