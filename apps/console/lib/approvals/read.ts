// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading an approval as the API returns it: its effective status (a live row past its expiry reads
// `expired`, one whose plan is no longer current reads `superseded`) and the 8-character digest
// prefix that both the agent and the approver are shown.

import { eq } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals } from "@/lib/db/schema";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import { bindingStaleReason, type Executor } from "./binding";
import { ApprovalError } from "./refusal";
import type { ApplyOperation, ApprovalStatus } from "./types";

/** The approval as the approvals API returns it. No requester note: it is shown only on the page. */
export interface ApprovalView {
	id: string;
	status: ApprovalStatus;
	operation: ApplyOperation;
	project_id: string;
	environment_id: string;
	plan_job_id: string;
	/** The first 8 characters of the approved plan digest, as both sides are shown it. */
	digest_prefix: string;
	expires_at: string;
	decided_at: string | null;
	/** The decider's reason for denying, when they gave one. UNTRUSTED text, shown as data. */
	decision_reason: string | null;
	consumed_job_id: string | null;
}

/** The first 8 characters of a plan digest. */
function digestPrefix(planSha256: string): string {
	return planSha256.slice(0, 8);
}

/** `approval` as the API returns it, with `status` the effective one. */
export async function viewOf(db: Executor, approval: ApplyApproval, now: Date = new Date()): Promise<ApprovalView> {
	let status: ApprovalStatus = approval.status;
	if ((status === "pending" || status === "approved") && approval.expires_at.getTime() <= now.getTime()) {
		status = "expired";
	} else if ((status === "pending" || status === "approved") && (await bindingStaleReason(db, approval))) {
		status = "superseded";
	}
	return {
		id: approval.id,
		status,
		operation: approval.operation,
		project_id: approval.project_id,
		environment_id: approval.environment_id,
		plan_job_id: approval.plan_job_id,
		digest_prefix: digestPrefix(approval.plan_sha256),
		expires_at: approval.expires_at.toISOString(),
		decided_at: approval.decided_at?.toISOString() ?? null,
		decision_reason: approval.decision_reason,
		consumed_job_id: approval.consumed_job_id,
	};
}

/** Approval `approvalId` for an actor in its org who may view the project, or a `not_found` refusal. */
export async function readApproval(db: Executor, actor: Actor, approvalId: string): Promise<ApprovalView> {
	const [approval] = await db.select().from(applyApprovals).where(eq(applyApprovals.id, approvalId)).limit(1);
	if (!approval || approval.org_id !== actor.orgId) {
		throw new ApprovalError("not_found", "That approval was not found in this organization.");
	}
	const allowed = await getPdp().can(actor, "view", { type: "project", id: approval.project_id });
	if (!allowed.allowed) throw new ApprovalError("not_found", "That approval was not found in this organization.");
	return viewOf(db, approval);
}
