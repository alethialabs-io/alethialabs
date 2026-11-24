// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The queue gate: the body of `requireApplyAuthorization` (lib/approvals/types.ts). It answers table
// 4.2 (policy.ts) for the job just inserted and, where the table asks for an approval, consumes one:
// decided by a person, unexpired, unused, bound to this org, project, environment, operation,
// requester and plan digest, and still current (binding.ts). The consume is a compare-and-set on
// `consumed_at IS NULL` in the transaction that inserted the job, and the job records the approval
// it consumed (`jobs.approval_id`, unique), so one approval queues one job once.
//
// The enterprise agent policy (enterprise-policy.ts), when one is registered, adds two answers: a
// person's own click to deploy production or to destroy needs a second person's approval while
// "require a different approver" applies, and an agent's OAuth client outside the org's allow-list is
// refused. Without one, both are core's: the click is the approval, and any client may ask.

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals, jobs } from "@/lib/db/schema";
import { bindingStaleReason, type Executor, staleMessage } from "./binding";
import { type AgentPolicy, readAgentPolicy, readEnvironment, tokenAutoApproves } from "./context";
import { type EnterpriseAgentPolicy, enterpriseAgentPolicy } from "./enterprise-policy";
import { planDigestOf } from "./plan-binding";
import { applyRequirement, policyRefusalMessage } from "./policy";
import { ApplyAuthorizationError } from "./refusal";
import type {
	ApplyAuthorization,
	ApplyOperation,
	ApplyRequester,
	ApplyTarget,
	SystemApplyOrigin,
} from "./types";

/** The one operation each system origin queues. Anything else from that origin is refused. */
const SYSTEM_ORIGIN_OPERATION: Record<SystemApplyOrigin, ApplyOperation> = {
	build_chain: "deploy",
	promotion: "deploy",
	auto_heal: "deploy",
	ephemeral_reap: "destroy",
};

/** What `requireApplyAuthorization` does; see its documentation in lib/approvals/types.ts. */
export async function authorizeApply(
	db: Executor,
	requester: ApplyRequester,
	operation: ApplyOperation,
	target: ApplyTarget,
	approvalId?: string | null,
): Promise<ApplyAuthorization> {
	if (requester.kind === "system") {
		// A system path re-applies what was already decided (a build's chained deploy, a promotion
		// whose gates passed, the last deployed snapshot) or tears down what expired. It carries no
		// approval; it may queue only the one operation its origin names.
		if (SYSTEM_ORIGIN_OPERATION[requester.origin] !== operation) {
			throw new ApplyAuthorizationError(
				"not_permitted",
				`The ${requester.origin} path does not queue a ${operation}.`,
			);
		}
		return { approvalId: null };
	}

	const { actor } = requester;
	if (actor.orgId !== target.orgId) {
		throw new ApplyAuthorizationError("not_permitted", "This environment belongs to another organization.");
	}
	const enterprise = enterpriseAgentPolicy();
	if (actor.credential === "session") {
		// A person at the console. The environments placed on a Fabric are destroyed in the same
		// transaction as the Fabric's own environment, which is gated last and consumes (or does not
		// need) the person's approval; an approval names one environment, so a cascaded one is covered
		// by that one rather than asked to consume it again.
		if (target.cascadeOfEnvironmentId) return { approvalId: null };
		// The click is the approval (table 4.2), unless the enterprise policy asks a second person for
		// this cell. An approval they present is still checked and consumed, so a presented approval is
		// never accepted unread.
		if (!approvalId && !enterprise) return { approvalId: null };
	}

	const environment = await readEnvironment(db, target.projectId, target.environmentId);
	if (!environment) {
		throw new ApplyAuthorizationError("not_permitted", "This environment is not part of the project.");
	}
	const policy = await readAgentPolicy(db, target.orgId);
	if (enterprise) {
		if (actor.credential === "session" && !approvalId) {
			if (!(await enterprise.sessionApplyNeedsSecondPerson(target.orgId, policy, operation, environment.stage))) {
				return { approvalId: null };
			}
			throw new ApplyAuthorizationError(
				"approval_required",
				`This organization requires a second person to approve this ${operation}. Request an approval for the reviewed plan, have a different person approve it in the console, then ${operation} with that approval.`,
			);
		}
		if (actor.credential === "agent_oauth") {
			const refusal = await enterprise.oauthClientRefusal(target.orgId, policy, actor.credentialRef ?? null);
			if (refusal) throw new ApplyAuthorizationError("not_permitted", refusal);
		}
	}
	// An approval decided before "require a different approver" applied is held to it when used.
	const approverCheck: ApproverCheck | null = enterprise ? { enterprise, policy } : null;
	const requirement = applyRequirement({
		credential: actor.credential,
		operation,
		stage: environment.stage,
		policy,
		tokenAutoApprovesEnvironment:
			operation === "deploy" && (await tokenAutoApproves(db, actor, target.environmentId)),
	});

	switch (requirement.kind) {
		case "refused":
			throw new ApplyAuthorizationError("not_permitted", policyRefusalMessage(requirement.reason, operation));
		case "none":
		case "automatic":
			return approvalId ? consumeApproval(db, actor, operation, target, approvalId, approverCheck) : { approvalId: null };
		case "approval":
			if (target.cascadeOfEnvironmentId) {
				// An approval covers one environment's destroy. The environments placed on its Fabric
				// are a separate teardown each, so a cascade is started by a person in the console.
				throw new ApplyAuthorizationError(
					"approval_required",
					"Destroying an environment together with the environments placed on it is started by a person in the console.",
				);
			}
			if (!approvalId) {
				throw new ApplyAuthorizationError(
					"approval_required",
					`This ${operation} needs a person's approval. Request an approval for the reviewed plan, have it approved in the console, then ${operation} with that approval.`,
				);
			}
			return consumeApproval(db, actor, operation, target, approvalId, approverCheck);
	}
}

/** The enterprise agent policy and the org's toggles, for the approver check at consume time. */
interface ApproverCheck {
	enterprise: EnterpriseAgentPolicy;
	policy: AgentPolicy;
}

/** Refuses with `approval_invalid` and `message`. */
function invalid(message: string): never {
	throw new ApplyAuthorizationError("approval_invalid", message);
}

/**
 * Consumes `approvalId` for the job `target.jobId`, or refuses saying why it does not cover it. Every
 * check reads the row locked FOR UPDATE, and the consume itself re-asserts status, single use and
 * expiry in its WHERE, so two jobs racing for one approval cannot both pass. With `approverCheck`,
 * an approval its own requester approved is refused while the enterprise policy requires a different
 * approver, so one decided before the toggle was turned on cannot be used after it.
 */
async function consumeApproval(
	db: Executor,
	actor: Actor,
	operation: ApplyOperation,
	target: ApplyTarget,
	approvalId: string,
	approverCheck: ApproverCheck | null,
): Promise<ApplyAuthorization> {
	const [approval] = await db
		.select()
		.from(applyApprovals)
		.where(eq(applyApprovals.id, approvalId))
		.limit(1)
		.for("update");
	if (!approval || approval.org_id !== target.orgId) invalid("That approval was not found in this organization.");
	if (
		approval.project_id !== target.projectId ||
		approval.environment_id !== target.environmentId ||
		approval.operation !== operation
	) {
		invalid(`That approval is for a different ${approval.operation} or environment.`);
	}
	if (
		approval.requester_user_id !== actor.userId ||
		approval.requester_credential !== actor.credential ||
		(approval.requester_credential_ref ?? null) !== (actor.credentialRef ?? null)
	) {
		invalid("That approval was requested by a different credential. Only the credential that requested it can use it.");
	}
	switch (approval.status) {
		case "approved":
			break;
		case "pending":
			throw new ApplyAuthorizationError(
				"approval_required",
				"That approval has not been decided yet. A person approves it in the console.",
			);
		case "rejected":
			invalid("That approval was rejected.");
		case "expired":
			invalid("That approval expired. Request a new one.");
		case "superseded":
			invalid("That approval was superseded by a newer plan or change. Request a new one.");
		case "consumed":
			invalid("That approval was already used. Each approval queues one job.");
	}
	if (approverCheck && approval.approver_user_id) {
		const refusal = await approverCheck.enterprise.approverRefusal(
			target.orgId,
			approverCheck.policy,
			approval.requester_user_id,
			approval.approver_user_id,
		);
		if (refusal) invalid(`${refusal} That approval was approved by the person it was requested for. Request a new one.`);
	}

	if (operation === "deploy") {
		// The deploy names its plan (`target.planJobId`, resolved current by resolveReviewedPlan before
		// the insert); the approval must be for that exact plan and digest.
		if (!target.planJobId || target.planJobId !== approval.plan_job_id) {
			invalid("That approval is for a different plan than this deploy applies.");
		}
		const [plan] = await db
			.select({ plan_sha256: jobs.plan_sha256, execution_metadata: jobs.execution_metadata })
			.from(jobs)
			.where(eq(jobs.id, target.planJobId))
			.limit(1);
		if (!plan || planDigestOf(plan) !== approval.plan_sha256) {
			invalid("The plan's digest is not the one that was approved. Plan again and request a new approval.");
		}
	}
	const stale = await bindingStaleReason(db, approval, target.jobId);
	if (stale) invalid(staleMessage(stale));

	const consumed = await db
		.update(applyApprovals)
		.set({
			status: "consumed",
			consumed_at: sql`now()`,
			consumed_job_id: target.jobId,
			updated_at: sql`now()`,
		})
		.where(
			and(
				eq(applyApprovals.id, approvalId),
				eq(applyApprovals.status, "approved"),
				isNull(applyApprovals.consumed_at),
				gt(applyApprovals.expires_at, sql`now()`),
			),
		)
		.returning({ id: applyApprovals.id });
	if (consumed.length === 0) invalid("That approval expired or was already used. Request a new one.");

	await db.update(jobs).set({ approval_id: approvalId }).where(eq(jobs.id, target.jobId));
	return { approvalId };
}
