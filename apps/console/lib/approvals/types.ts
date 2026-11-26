// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The apply-authorization question: asked wherever a job that applies or destroys infrastructure is
// queued, and the vocabulary it is asked in.
//
// `requireApplyAuthorization` below is the queue gate. It answers table 4.2 of the agent-surface spec
// (lib/approvals/policy.ts): a person at the console needs nothing beyond the PDP verb; a CLI login, a
// connected agent or a service token needs a person's approval, bound to the reviewed plan and used
// once (lib/approvals/gate.ts). Which files queue such a job, and that each of them asks, is held by
// tests/lib/approvals/apply-authorization.test.ts.

import type { Actor } from "@/lib/authz/types";
import type { Db, Tx } from "@/lib/db";
import { authorizeApply } from "./gate";

export {
	APPLY_REFUSAL_CODES,
	ApplyAuthorizationError,
	type ApplyRefusalCode,
} from "./refusal";

/** The two operations that need the question asked. A plan never does. */
export const APPLY_OPERATIONS = ["deploy", "destroy"] as const;

/** One of {@link APPLY_OPERATIONS}. */
export type ApplyOperation = (typeof APPLY_OPERATIONS)[number];

// Defined in an import-free module so client components can read them (see ./scopes.ts).
export { AGENT_SCOPES, type AgentScope } from "./scopes";

/** The states of an approval. Only `approved` can be consumed, and only once. */
export const APPROVAL_STATUSES = [
	"pending",
	"approved",
	"rejected",
	"expired",
	"superseded",
	"consumed",
] as const;

/** One of {@link APPROVAL_STATUSES}. */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The paths that queue an apply or a destroy with no actor behind the request: the job is a
 * consequence of something already decided, or of a rule the org switched on.
 *
 * - `build_chain` — the DEPLOY queued when a BUILD job succeeds (lib/jobs/finalize-build.ts).
 * - `promotion` — the DEPLOY queued when a promotion's gates pass (lib/promotions/lifecycle.ts).
 * - `auto_heal` — the DEPLOY that reconciles a drifted environment (lib/reconcile/auto-heal.ts).
 * - `ephemeral_reap` — the DESTROY of an expired ephemeral environment (lib/reconcile/reap.ts).
 */
export const SYSTEM_APPLY_ORIGINS = [
	"build_chain",
	"promotion",
	"auto_heal",
	"ephemeral_reap",
] as const;

/** One of {@link SYSTEM_APPLY_ORIGINS}. */
export type SystemApplyOrigin = (typeof SYSTEM_APPLY_ORIGINS)[number];

/**
 * Who is behind a queued apply or destroy: an actor (a person, or a credential acting for one),
 * or a named system path. A union on `kind`, so a system path cannot be mistaken for an actor
 * with fields missing.
 */
export type ApplyRequester =
	| { kind: "actor"; actor: Actor }
	| { kind: "system"; origin: SystemApplyOrigin };

/** What the job is aimed at, and the job itself. */
export interface ApplyTarget {
	orgId: string;
	projectId: string;
	environmentId: string;
	/**
	 * The job just inserted in `tx`, which stands only if this call returns. It is a DEPLOY or a
	 * DESTROY, or the BUILD whose success queues a DEPLOY of the same snapshot.
	 */
	jobId: string;
	/**
	 * The reviewed PLAN job a DEPLOY applies, when the caller named one. On a DESTROY, a destroy plan
	 * the caller named, which must then be the one its approval names; a destroy that consumes an
	 * approval is stamped with the approval's destroy plan either way (gate.ts).
	 */
	planJobId?: string;
	/**
	 * Set on a DESTROY queued because another environment's destroy cascaded to this one: the
	 * environment the caller asked to destroy.
	 */
	cascadeOfEnvironmentId?: string;
}

/** What {@link requireApplyAuthorization} answers when the job may stand. */
export interface ApplyAuthorization {
	/** The approval this job consumed, or null when it needed none. */
	approvalId: string | null;
}

/**
 * May this apply or destroy be queued? Called once for every job a queueing site inserts, after the
 * insert and before anything else is written for it. A refusal is an `ApplyAuthorizationError`; inside
 * a transaction it rolls the job back, so nothing is left queued.
 *
 * - An actor is answered by table 4.2 (lib/approvals/policy.ts). Where the table asks for an approval,
 *   `approvalId` must name one that a person approved, that has not expired or been used, that the
 *   same credential requested for this org, project, environment and operation, and whose plan digest
 *   is still the environment's current one (lib/approvals/binding.ts). It is consumed here, and the
 *   job records it (`jobs.approval_id`). A DESTROY that consumes one is also stamped with the destroy
 *   plan it names (`plan_job_id`, `plan_sha256`), which the runner then tears down and nothing else.
 * - A system origin is allowed the one operation it names (lib/approvals/gate.ts), with no approval.
 *
 * Answers the approval the job consumed, or null when it needed none.
 */
export async function requireApplyAuthorization(
	db: Db | Tx,
	requester: ApplyRequester,
	operation: ApplyOperation,
	target: ApplyTarget,
	approvalId?: string | null,
): Promise<ApplyAuthorization> {
	return authorizeApply(db, requester, operation, target, approvalId);
}
