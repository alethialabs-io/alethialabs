// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Requesting an approval (spec §4.3): the one call behind `POST /api/approvals`, and behind the MCP
// `request_apply` / `request_destroy` tools and the in-product agent when they arrive. It never queues
// a job; it records what a person will be asked to approve.

import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals, jobs } from "@/lib/db/schema";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import { appliedState, bindingStaleReason, type Executor, staleMessage } from "./binding";
import { readAgentPolicy, readEnvironment } from "./context";
import { enterpriseAgentPolicy } from "./enterprise-policy";
import { planDigestOf } from "./plan-binding";
import { applyRequirement, policyRefusalMessage } from "./policy";
import { ApprovalError } from "./refusal";
import type { ApplyOperation } from "./types";

/** The longest requester note kept. It is untrusted text, shown as such. */
export const MAX_REASON_LENGTH = 500;

/** What is asked for. */
export interface ApprovalRequestInput {
	/** The reviewed PLAN job. For a destroy, the plan the environment's current state was applied from. */
	planJobId: string;
	operation: ApplyOperation;
	/** The requester's note, untrusted. */
	reason?: string | null;
}

/**
 * Records a pending approval for `actor` to `operation` the plan `input.planJobId`, or returns the live
 * one this same credential already asked for (idempotent on plan, operation and requester). Runs in
 * `db`, which the caller opens in the actor's tenancy scope.
 *
 * Refused (an {@link ApprovalError}) when the actor lacks the PDP verb on the project, when the plan is
 * not this org's, has not succeeded, has no digest, failed verification or is no longer current, and
 * when the org's agent policy refuses the operation outright (including, through the enterprise agent
 * policy, an OAuth client outside the org's allow-list). A pending approval of an older plan for
 * the same environment and operation is marked superseded.
 */
export async function requestApproval(
	db: Executor,
	actor: Actor,
	input: ApprovalRequestInput,
): Promise<ApplyApproval> {
	const [plan] = await db
		.select({
			id: jobs.id,
			org_id: jobs.org_id,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			status: jobs.status,
			configuration_hash: jobs.configuration_hash,
			plan_sha256: jobs.plan_sha256,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(and(eq(jobs.id, input.planJobId), eq(jobs.job_type, "PLAN")))
		.limit(1);
	if (!plan || plan.org_id !== actor.orgId || !plan.project_id || !plan.environment_id) {
		throw new ApprovalError("not_found", "That plan was not found in this organization.");
	}
	const { project_id: projectId, environment_id: environmentId } = plan;
	// The request needs the verb it would unlock; a token's scopes and projects narrow it (getPdp).
	const verb = input.operation === "deploy" ? "deploy" : "destroy";
	const decision = await getPdp().can(actor, verb, { type: "project", id: projectId });
	if (!decision.allowed) throw new ApprovalError("not_found", "That plan was not found in this organization.");

	const environment = await readEnvironment(db, projectId, environmentId);
	if (!environment) throw new ApprovalError("not_found", "That plan's environment was not found.");
	const policy = await readAgentPolicy(db, actor.orgId);
	const requirement = applyRequirement({
		credential: actor.credential,
		operation: input.operation,
		stage: environment.stage,
		policy,
		tokenAutoApprovesEnvironment: false,
	});
	if (requirement.kind === "refused") {
		throw new ApprovalError("not_permitted", policyRefusalMessage(requirement.reason, input.operation));
	}
	// An agent's OAuth client outside the org's allow-list may not ask (enterprise-policy.ts).
	const enterprise = await enterpriseAgentPolicy();
	if (enterprise && actor.credential === "agent_oauth") {
		const refusal = await enterprise.oauthClientRefusal(actor.orgId, policy, actor.credentialRef ?? null);
		if (refusal) throw new ApprovalError("not_permitted", refusal);
	}

	if (plan.status !== "SUCCESS") {
		throw new ApprovalError("plan_not_approvable", `Plan ${plan.id} has not succeeded (status ${plan.status}).`);
	}
	const digest = planDigestOf(plan);
	if (!digest) {
		throw new ApprovalError("plan_not_approvable", `Plan ${plan.id} has no recorded plan digest. Plan again.`);
	}
	if (plan.execution_metadata?.verify_receipt?.receipt?.verdict === "fail") {
		throw new ApprovalError(
			"plan_not_approvable",
			`Plan ${plan.id} failed verification, and an approval does not waive a failed verification.`,
		);
	}
	if (input.operation === "destroy") {
		const applied = await appliedState(db, environmentId);
		if (!applied || applied.planJobId !== plan.id) {
			throw new ApprovalError(
				"plan_not_approvable",
				"A destroy is approved against the plan the environment's current state was deployed from. Name that plan.",
			);
		}
	}
	const binding = { environment_id: environmentId, operation: input.operation, plan_job_id: plan.id, plan_sha256: digest };
	const stale = await bindingStaleReason(db, binding);
	if (stale) throw new ApprovalError("plan_not_approvable", staleMessage(stale));

	const credentialRef = actor.credentialRef ?? null;
	const sameRequester = and(
		eq(applyApprovals.plan_job_id, plan.id),
		eq(applyApprovals.operation, input.operation),
		eq(applyApprovals.requester_user_id, actor.userId),
		eq(applyApprovals.requester_credential, actor.credential),
		sql`coalesce(${applyApprovals.requester_credential_ref}, '') = ${credentialRef ?? ""}`,
	);
	// A live row past its expiry is expired: it no longer holds the idempotency slot.
	await db
		.update(applyApprovals)
		.set({ status: "expired", updated_at: sql`now()` })
		.where(and(sameRequester, inArray(applyApprovals.status, ["pending", "approved"]), lte(applyApprovals.expires_at, sql`now()`)));
	// An older plan's live approval for this environment and operation is void now (§4.3).
	await db
		.update(applyApprovals)
		.set({ status: "superseded", updated_at: sql`now()` })
		.where(
			and(
				eq(applyApprovals.environment_id, environmentId),
				eq(applyApprovals.operation, input.operation),
				ne(applyApprovals.plan_job_id, plan.id),
				inArray(applyApprovals.status, ["pending", "approved"]),
			),
		);

	const reason = input.reason?.trim().slice(0, MAX_REASON_LENGTH) || null;
	await db
		.insert(applyApprovals)
		.values({
			org_id: actor.orgId,
			project_id: projectId,
			environment_id: environmentId,
			operation: input.operation,
			plan_job_id: plan.id,
			plan_sha256: digest,
			config_hash: plan.configuration_hash,
			requester_user_id: actor.userId,
			requester_credential: actor.credential,
			requester_credential_ref: credentialRef,
			reason,
			expires_at: sql`now() + make_interval(mins => ${policy.approvalTtlMinutes})`,
		})
		.onConflictDoNothing();
	const [live] = await db
		.select()
		.from(applyApprovals)
		.where(and(sameRequester, inArray(applyApprovals.status, ["pending", "approved"])))
		.limit(1);
	if (!live) throw new Error("apply_approvals: the requested approval was not readable after insert");
	return live;
}
