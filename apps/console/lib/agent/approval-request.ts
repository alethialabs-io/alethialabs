// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-product agent's half of the approval path (agent surface §4.6): what its `request_apply` and
// `request_destroy` tools do. The same engine as `POST /api/approvals` (lib/approvals/request.ts),
// asked as `agent_in_app`, so the in-product agent's applies follow the same approval path as
// connected agents: the request is bound to a succeeded, current plan and its digest; the org's kill
// switch and "agents may not apply to production" refuse it; a person decides it in the console; and
// the queue gate (lib/approvals/gate.ts) consumes it once.
//
// It never queues a job. The approval card in the conversation (components/agent/approval/**) is where
// a person decides it, and where the requester starts the approved job (lib/agent/approval-actions.ts).

import { z } from "zod";
import { type ApprovalView, viewOf } from "@/lib/approvals/read";
import { ApprovalError } from "@/lib/approvals/refusal";
import { requestApproval } from "@/lib/approvals/request";
import type { ApplyOperation } from "@/lib/approvals/types";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import type { InAppApprovalOutput } from "./approval-output";
import { isInAppAgent } from "./in-app-credential";

/** What the model passes: the shared `request_apply` input (lib/ai/mcp/surface.ts). */
export interface InAppApprovalInput {
	plan_job_id: string;
	reason?: string;
}

/** The output for an approval that was recorded (or was already live for this conversation). */
function requested(view: ApprovalView): InAppApprovalOutput {
	return {
		status: "requested",
		approval_id: view.id,
		approval_status: view.status,
		operation: view.operation,
		project_id: view.project_id,
		environment_id: view.environment_id,
		plan_job_id: view.plan_job_id,
		digest_prefix: view.digest_prefix,
		expires_at: view.expires_at,
	};
}

/**
 * Records a pending approval for the in-product agent to `operation` the plan `input.plan_job_id`, as
 * the person the conversation belongs to, or returns the live one this conversation already asked
 * for. Answers a refusal as a value (the model relays it), and refuses outright when it is not running
 * inside a chat turn: an approval is never recorded as anything but `agent_in_app` from here.
 */
export async function requestInAppApproval(
	operation: ApplyOperation,
	input: InAppApprovalInput,
): Promise<InAppApprovalOutput> {
	const actor = await currentActor();
	if (!isInAppAgent(actor)) {
		return {
			status: "refused",
			code: "not_permitted",
			reason: "An approval is requested by the assistant from inside a conversation.",
		};
	}
	const planJobId = z.uuid().safeParse(input.plan_job_id);
	if (!planJobId.success) {
		return {
			status: "refused",
			code: "not_found",
			reason: "plan_job_id must be the id of a succeeded plan job (a UUID). Read it from list_jobs or get_job.",
		};
	}
	try {
		const view = await withActorScope(actor, async (tx) => {
			const approval = await requestApproval(tx, actor, {
				planJobId: planJobId.data,
				operation,
				reason: input.reason,
			});
			return viewOf(tx, approval);
		});
		return requested(view);
	} catch (err) {
		if (err instanceof ApprovalError) return { status: "refused", code: err.code, reason: err.message };
		throw err;
	}
}
