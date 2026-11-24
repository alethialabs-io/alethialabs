// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a pending approval can still be APPROVED, asked at decision time (AGT-L2, gap G14). An
// approval waits up to 24 hours; the org's agent policy can change underneath it. So the decision
// sheet asks this to disable Approve with the reason, and `decideApproval` asks it again so a stale
// sheet cannot approve either. Deny is never blocked: refusing a request is always allowed.
//
// The core answer is table 4.2 (policy.ts `applyRequirement`), the same function the request path
// and the queue gate read, so the three cannot disagree about what the policy refuses. Like the gate,
// the agent-policy toggles bind only the agent credentials (`agent_oauth`, `agent_in_app`); a CLI
// login's or a service token's request is unaffected by them.
//
// The enterprise toggles (AGT-L14) are asked through the same seam the gate uses
// (enterprise-policy.ts): "require a different approver" (`approverRefusal`) and the OAuth client
// allow-list (`oauthClientRefusal`, for a request an `agent_oauth` client made). With no enterprise
// agent policy registered, core answers: a person may approve their own agent's request (decision
// D6), and any client is allowed.

import type { CredentialKind } from "@/lib/authz/types";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { Executor } from "./binding";
import { type AgentPolicy, readAgentPolicy, readEnvironment } from "./context";
import { type EnterpriseAgentPolicy, enterpriseAgentPolicy } from "./enterprise-policy";
import { applyRequirement, type PolicyRefusal, policyRefusalMessage } from "./policy";
import type { ApplyOperation } from "./types";

/** The longest decision reason stored (`apply_approvals_decision_reason_length`). */
export const DECISION_REASON_MAX = 500;

/**
 * Why Approve is unavailable: a core policy refusal, the enterprise allow-list leaving the requesting
 * app out, or the enterprise different-approver rule.
 */
export type ApproveBlockReason = PolicyRefusal | "client_not_allowed" | "self_approval";

/** Approve is unavailable for `reason`; `message` is the sentence the person is shown. */
export interface ApproveBlock {
	reason: ApproveBlockReason;
	message: string;
}

/** The facts the core answer reads: the request's credential and operation, the stage, the policy. */
export interface ApproveBlockInput {
	credential: CredentialKind;
	operation: ApplyOperation;
	stage: EnvironmentStage;
	policy: AgentPolicy;
}

/**
 * The core half: why the org's agent policy refuses approving this request, or null. Pure, so the
 * whole table is a parameterised test.
 */
export function approveBlock(input: ApproveBlockInput): ApproveBlock | null {
	const requirement = applyRequirement({
		credential: input.credential,
		operation: input.operation,
		stage: input.stage,
		policy: input.policy,
		// Automatic deploys never create an approval, so this cell is never the question here.
		tokenAutoApprovesEnvironment: false,
	});
	if (requirement.kind === "refused") {
		return { reason: requirement.reason, message: policyRefusalMessage(requirement.reason, input.operation) };
	}
	return null;
}

/** The approval fields the answer reads. */
export type ApprovalForBlock = Pick<
	ApplyApproval,
	"org_id" | "operation" | "requester_credential" | "requester_credential_ref" | "requester_user_id"
>;

/**
 * The whole answer for `approval` and the deciding person: the core policy first (no other person
 * could approve a request the policy refuses), then the enterprise allow-list, then the enterprise
 * different-approver rule. `enterprise` is the registered agent policy, or null for core alone.
 */
export async function resolveApproveBlock(
	approval: ApprovalForBlock,
	facts: { policy: AgentPolicy; stage: EnvironmentStage; deciderUserId: string },
	enterprise: EnterpriseAgentPolicy | null,
): Promise<ApproveBlock | null> {
	const core = approveBlock({
		credential: approval.requester_credential,
		operation: approval.operation,
		stage: facts.stage,
		policy: facts.policy,
	});
	if (core) return core;
	if (!enterprise) return null;
	if (approval.requester_credential === "agent_oauth") {
		const refusal = await enterprise.oauthClientRefusal(approval.org_id, facts.policy, approval.requester_credential_ref ?? null);
		if (refusal) return { reason: "client_not_allowed", message: refusal };
	}
	const approver = await enterprise.approverRefusal(approval.org_id, facts.policy, approval.requester_user_id, facts.deciderUserId);
	if (approver) return { reason: "self_approval", message: approver };
	return null;
}

/**
 * {@link resolveApproveBlock} for `approval` and `deciderUserId`, reading the org's policy, the
 * environment's stage and the registered enterprise agent policy. An environment that cannot be read
 * is treated as production, the stricter answer.
 */
export async function readApproveBlock(
	db: Executor,
	approval: ApprovalForBlock & Pick<ApplyApproval, "project_id" | "environment_id">,
	deciderUserId: string,
): Promise<ApproveBlock | null> {
	const policy = await readAgentPolicy(db, approval.org_id);
	const environment = await readEnvironment(db, approval.project_id, approval.environment_id);
	return resolveApproveBlock(
		approval,
		{ policy, stage: environment?.stage ?? "production", deciderUserId },
		await enterpriseAgentPolicy(),
	);
}
