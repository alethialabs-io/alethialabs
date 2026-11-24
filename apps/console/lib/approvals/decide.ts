// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deciding an approval (spec §4.3): only a person signed in to the console, with a recent sign-in,
// who holds the PDP verb on the project. Every other credential kind is refused, so no token and no
// agent can approve its own request. When the org requires a different approver and holds the
// enterprise entitlement for it, the requester's own person is refused too (enterprise-policy.ts); in
// core a person may approve what their own agent asked (decision D6).

import { and, eq, sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals } from "@/lib/db/schema";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import { bindingStaleReason, type Executor, staleMessage } from "./binding";
import { readAgentPolicy, readEnvironment } from "./context";
import { enterpriseAgentPolicy } from "./enterprise-policy";
import { ApprovalError } from "./refusal";

/**
 * How old a console sign-in may be and still decide: one day, Better Auth's own default for a "fresh"
 * session (the age its sensitive endpoints require).
 */
export const DECIDER_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The person deciding, as `decideApplyApproval` (app/server/actions/approvals.ts) reads them from the console session. */
export interface Decider {
	actor: Actor;
	/** The Better Auth session the decision is made in. */
	sessionId: string;
	/** When that session was created, i.e. when the person last signed in. */
	sessionCreatedAt: Date;
}

/** The decision, and for a destroy the environment name the person typed to confirm it. */
export interface DecisionInput {
	decision: "approve" | "reject";
	confirmEnvironmentName?: string | null;
}

/** What deciding produced: the decided row, or a refusal recorded on the row (expired, superseded). */
export type DecisionResult = { ok: true; approval: ApplyApproval } | { ok: false; error: ApprovalError };

/**
 * Decides approval `approvalId` for `decider`, in `db` opened in the decider's tenancy scope. Throws
 * an {@link ApprovalError} for a refusal that changes nothing; returns `{ ok: false }` for one that is
 * also recorded on the row (it expired, or its plan was superseded), so the caller commits that.
 */
export async function decideApproval(
	db: Executor,
	decider: Decider,
	approvalId: string,
	input: DecisionInput,
	now: Date = new Date(),
): Promise<DecisionResult> {
	const { actor } = decider;
	if (actor.credential !== "session" || actor.ceiling) {
		throw new ApprovalError("not_a_person", "An approval is decided by a person signed in to the console.");
	}
	if (now.getTime() - decider.sessionCreatedAt.getTime() > DECIDER_SESSION_MAX_AGE_MS) {
		throw new ApprovalError("reauthentication_required", "Sign in again to decide this approval.");
	}

	const [approval] = await db
		.select()
		.from(applyApprovals)
		.where(eq(applyApprovals.id, approvalId))
		.limit(1)
		.for("update");
	if (!approval || approval.org_id !== actor.orgId) {
		throw new ApprovalError("not_found", "That approval was not found in this organization.");
	}
	const verb = approval.operation === "deploy" ? "deploy" : "destroy";
	const allowed = await getPdp().can(actor, verb, { type: "project", id: approval.project_id });
	if (!allowed.allowed) throw new ApprovalError("not_found", "That approval was not found in this organization.");

	if (approval.status !== "pending") {
		throw new ApprovalError("not_pending", `That approval is ${approval.status}, not pending.`);
	}
	if (approval.expires_at.getTime() <= now.getTime()) {
		return { ok: false, error: await markVoid(db, approval.id, "expired", "That approval expired before it was decided.") };
	}
	const stale = await bindingStaleReason(db, approval);
	if (stale) return { ok: false, error: await markVoid(db, approval.id, "superseded", staleMessage(stale)) };

	if (input.decision === "approve") {
		const enterprise = enterpriseAgentPolicy();
		if (enterprise) {
			const policy = await readAgentPolicy(db, approval.org_id);
			const refusal = await enterprise.approverRefusal(approval.org_id, policy, approval.requester_user_id, actor.userId);
			if (refusal) throw new ApprovalError("self_approval", refusal);
		}
		if (approval.operation === "destroy") {
			const environment = await readEnvironment(db, approval.project_id, approval.environment_id);
			if (!environment || input.confirmEnvironmentName?.trim() !== environment.name) {
				throw new ApprovalError("confirmation_mismatch", "Type the environment's name to approve its destroy.");
			}
		}
	}

	const [decided] = await db
		.update(applyApprovals)
		.set({
			status: input.decision === "approve" ? "approved" : "rejected",
			approver_user_id: actor.userId,
			approver_session_id: decider.sessionId,
			decided_at: sql`now()`,
			updated_at: sql`now()`,
		})
		.where(and(eq(applyApprovals.id, approval.id), eq(applyApprovals.status, "pending")))
		.returning();
	if (!decided) throw new ApprovalError("not_pending", "That approval was decided by someone else first.");
	return { ok: true, approval: decided };
}

/** Marks a pending approval `status` and returns the refusal that says why. */
async function markVoid(
	db: Executor,
	id: string,
	status: "expired" | "superseded",
	message: string,
): Promise<ApprovalError> {
	await db
		.update(applyApprovals)
		.set({ status, updated_at: sql`now()` })
		.where(and(eq(applyApprovals.id, id), eq(applyApprovals.status, "pending")));
	return new ApprovalError("not_pending", message);
}
