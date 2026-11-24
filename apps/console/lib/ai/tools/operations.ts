// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { requestInAppApproval } from "@/lib/agent/approval-request";
import { EXTERNAL_TOOLS } from "@/lib/ai/mcp/surface";
import { operationSchema, proposeOperationInputSchema } from "../operation";

const PLAN_DESCRIPTION =
	"Propose a PLAN of an EXISTING project for the user to APPROVE. Planning queues a PLAN job and changes nothing in the cloud; it runs only when the user approves the proposal. After the plan succeeds (check get_plan_result), call request_apply with its job id to ask a person to approve the deploy.";

const REQUEST_SUFFIX =
	" The approval card appears in this conversation: the user (or, when the organization requires it, another person) approves it there, and the job starts from the card. Tell the user what you requested and its 8-character digest; never say it is approved or running. A refusal is returned with its reason: relay it, do not retry the same request.";

/** The `plan_project` member of the stored proposal union: the only operation a proposal carries now. */
const [planOperationSchema] = operationSchema.options;

/**
 * The plan proposal's input. A stored proposal of a deploy (`provision_project`) still parses for the
 * card (lib/ai/operation.ts), but the model can no longer propose one: a deploy is requested with
 * `request_apply`, which a person approves (table 4.2).
 */
const proposePlanInputSchema = proposeOperationInputSchema.extend({ operation: planOperationSchema });

/**
 * Operation tools — Act mode only.
 *
 * - `propose_operation` proposes a PLAN. It is a HITL (human-in-the-loop) tool: it has NO `execute`,
 *   so the model's turn pauses until the user approves it in the card, which queues the plan and
 *   feeds the outcome back via `addToolResult`. A plan changes nothing in the cloud (table 4.2 asks
 *   no approval of any credential for one), so the card's click is all it takes.
 * - `request_apply` / `request_destroy` are the shared tools of the agent surface
 *   (lib/ai/mcp/surface.ts), with its input. They record an approval request as the in-product agent
 *   (`agent_in_app`, bound by the turn route) and never queue a job: the in-product agent's applies
 *   follow the same approval path as connected agents (lib/agent/approval-request.ts).
 *
 * `opts.environmentId` is the environment the conversation is scoped to (the project route resolves
 * it). The plan description names it so the model fills `environmentId` on every proposal — an
 * omitted id reaches the action as "the project's default environment", which is exactly the wrong
 * target when the user is looking at any other one. A request needs no environment: it names a plan,
 * and the plan names its environment.
 */
export function operationTools(opts?: { environmentId?: string | null }) {
	const scoped = opts?.environmentId
		? ` This conversation is scoped to environment id ${opts.environmentId}: set environmentId to exactly that id on every proposal (never omit it, never substitute another environment).`
		: "";
	return {
		propose_operation: tool({
			description: PLAN_DESCRIPTION + scoped,
			inputSchema: proposePlanInputSchema,
			// No execute — the user approves client-side; the outcome returns via addToolResult.
		}),
		request_apply: tool({
			description: `${EXTERNAL_TOOLS.request_apply.title}: ask a person to approve deploying a succeeded plan. Pass the plan job id; the deploy applies exactly that plan.${REQUEST_SUFFIX}`,
			inputSchema: EXTERNAL_TOOLS.request_apply.inputSchema,
			execute: (input) => requestInAppApproval("deploy", input),
		}),
		request_destroy: tool({
			description: `${EXTERNAL_TOOLS.request_destroy.title}: ask a person to approve destroying an environment. Pass the plan job id the environment's current state was deployed from (the plan its latest successful deploy applied).${REQUEST_SUFFIX}`,
			inputSchema: EXTERNAL_TOOLS.request_destroy.inputSchema,
			execute: (input) => requestInAppApproval("destroy", input),
		}),
	};
}
