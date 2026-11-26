// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approval reads and writes the MCP approval tools make (lib/ai/mcp/handlers.ts), over the
// approval engine (lib/approvals). Every read runs in the actor's tenancy scope (RLS) and is also
// filtered to the actor's org and, for the requester's own approvals, to the requester's exact
// credential — so an approval is only ever found by the credential that asked for it.

import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { readEnvironment } from "@/lib/approvals/context";
import { currentDestroyPlan } from "@/lib/approvals/binding";
import { type ApprovalView, readApproval, viewOf } from "@/lib/approvals/read";
import { ApprovalError } from "@/lib/approvals/refusal";
import { requestApproval } from "@/lib/approvals/request";
import type { ApplyOperation } from "@/lib/approvals/types";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { applyApprovals } from "@/lib/db/schema";

/**
 * The newest approval `actor`'s own credential requested for `operation` on plan `planJobId`, with its
 * effective status, or null when it has asked for none. "Own" is the same person, the same credential
 * kind and the same credential reference (for an MCP token, the OAuth client), which is the binding the
 * queue gate checks when the approval is consumed (lib/approvals/gate.ts).
 *
 * Read through `readApproval`, so an actor who can no longer view the project gets a `not_found`
 * refusal rather than its old approval.
 */
export async function findOwnApproval(
	actor: Actor,
	planJobId: string,
	operation: ApplyOperation,
): Promise<ApprovalView | null> {
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: applyApprovals.id })
			.from(applyApprovals)
			.where(
				and(
					eq(applyApprovals.org_id, actor.orgId),
					eq(applyApprovals.plan_job_id, planJobId),
					eq(applyApprovals.operation, operation),
					eq(applyApprovals.requester_user_id, actor.userId),
					eq(applyApprovals.requester_credential, actor.credential),
					sql`coalesce(${applyApprovals.requester_credential_ref}, '') = ${actor.credentialRef ?? ""}`,
				),
			)
			.orderBy(desc(applyApprovals.created_at))
			.limit(1);
		return row ? readApproval(tx, actor, row.id) : null;
	});
}

/** Records (or returns the live) approval request for `actor`, as the approvals API does. */
export async function requestOwnApproval(
	actor: Actor,
	input: { planJobId: string; operation: ApplyOperation; reason?: string | null },
): Promise<ApprovalView> {
	return withActorScope(actor, async (tx) => viewOf(tx, await requestApproval(tx, actor, input)));
}

/** Approval `approvalId` for an actor who may view its project, or a `not_found` refusal. */
export async function readOwnOrgApproval(actor: Actor, approvalId: string): Promise<ApprovalView> {
	return withActorScope(actor, (tx) => readApproval(tx, actor, approvalId));
}

/**
 * The plan a destroy of `environmentId` is approved against: the environment's latest succeeded
 * destroy plan, while it is still current (lib/approvals/binding.ts, #7455). Refuses `not_found` when
 * the actor may not view the project or the environment is not one of its environments, and
 * `plan_not_approvable` when there is no current destroy plan to name.
 */
export async function destroyPlanFor(
	actor: Actor,
	projectId: string,
	environmentId: string,
): Promise<string> {
	const decision = await getPdp().can(actor, "view", { type: "project", id: projectId });
	if (!decision.allowed) {
		throw new ApprovalError("not_found", "That environment was not found in this organization.");
	}
	return withActorScope(actor, async (tx) => {
		const environment = await readEnvironment(tx, projectId, environmentId);
		if (!environment) {
			throw new ApprovalError("not_found", "That environment was not found in this organization.");
		}
		const plan = await currentDestroyPlan(tx, environmentId);
		if (!plan) {
			throw new ApprovalError(
				"plan_not_approvable",
				"This environment has no current destroy plan, so there is no teardown an approval can name. A destroy is approved against a destroy plan of the environment, queued after the last change to it. A person can also destroy it from the console.",
			);
		}
		return plan.planJobId;
	});
}
