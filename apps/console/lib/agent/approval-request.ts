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
import { destroyPlanFor } from "@/lib/ai/mcp/approval-store";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import type { InAppApprovalOutput } from "./approval-output";
import { isInAppAgent } from "./in-app-credential";

/** What the model passes to `request_apply`: the shared input (lib/ai/mcp/surface.ts). */
export interface InAppApplyInput {
	plan_job_id: string;
	reason?: string;
}

/**
 * What the model passes to `request_destroy`: the shared input (lib/ai/mcp/surface.ts). It names the
 * environment, not a plan; the server binds the destroy to the environment's current destroy plan,
 * as the engine requires (lib/approvals/binding.ts).
 */
export interface InAppDestroyInput {
	project_id: string;
	environment_id: string;
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

/** The refusal for a call made outside a chat turn. */
const OUTSIDE_A_TURN: InAppApprovalOutput = {
	status: "refused",
	code: "not_permitted",
	reason: "An approval is requested by the assistant from inside a conversation.",
};

/**
 * Records a pending approval for the in-product agent `actor` to `operation` the plan `planJobId`, or
 * returns the live one this conversation already asked for. `planJobId` may be a lookup, run first and
 * inside the same refusal handling. Answers a refusal as a value (the model relays it).
 */
async function record(
	actor: Actor,
	operation: ApplyOperation,
	planJobId: string | (() => Promise<string>),
	reason: string | undefined,
): Promise<InAppApprovalOutput> {
	try {
		const planId = typeof planJobId === "string" ? planJobId : await planJobId();
		const view = await withActorScope(actor, async (tx) => {
			const approval = await requestApproval(tx, actor, { planJobId: planId, operation, reason });
			return viewOf(tx, approval);
		});
		return requested(view);
	} catch (err) {
		if (err instanceof ApprovalError) return { status: "refused", code: err.code, reason: err.message };
		throw err;
	}
}

/**
 * `request_apply` for the in-product agent: records a pending approval to deploy the plan
 * `input.plan_job_id`, as the person the conversation belongs to. Refuses outright when it is not
 * running inside a chat turn: an approval is never recorded as anything but `agent_in_app` from here.
 */
export async function requestInAppApply(input: InAppApplyInput): Promise<InAppApprovalOutput> {
	const actor = await currentActor();
	if (!isInAppAgent(actor)) return OUTSIDE_A_TURN;
	const planJobId = z.uuid().safeParse(input.plan_job_id);
	if (!planJobId.success) {
		return {
			status: "refused",
			code: "not_found",
			reason: "plan_job_id must be the id of a succeeded plan job (a UUID). Read it from list_jobs or get_job.",
		};
	}
	return record(actor, "deploy", planJobId.data, input.reason);
}

/**
 * `request_destroy` for the in-product agent: records a pending approval to destroy the environment
 * `input.environment_id`, bound to the environment's current destroy plan (the same lookup the
 * connected agents' tool uses, lib/ai/mcp/approval-store.ts). Refuses outside a chat turn.
 */
export async function requestInAppDestroy(input: InAppDestroyInput): Promise<InAppApprovalOutput> {
	const actor = await currentActor();
	if (!isInAppAgent(actor)) return OUTSIDE_A_TURN;
	const ids = z.object({ project_id: z.uuid(), environment_id: z.uuid() }).safeParse(input);
	if (!ids.success) {
		return {
			status: "refused",
			code: "not_found",
			reason: "project_id and environment_id must be ids (UUIDs). Read them from list_resources.",
		};
	}
	return record(
		actor,
		"destroy",
		() => destroyPlanFor(actor, ids.data.project_id, ids.data.environment_id),
		input.reason,
	);
}
