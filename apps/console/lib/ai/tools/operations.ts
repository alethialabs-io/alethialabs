// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { proposeOperationInputSchema } from "../operation";

const BASE_DESCRIPTION =
	"Propose a plan or deploy operation on an EXISTING project for the user to APPROVE. Planning queues a PLAN job; deploying provisions LIVE infrastructure — both require this approval, never run without it. After a plan succeeds (check get_plan_result), propose provision_project with its planJobId + the add/change/destroy + monthly stats so the user can review before deploying.";

/**
 * Mutation tools — Act mode only. `propose_operation` is a HITL (human-in-the-loop)
 * tool: it has NO `execute`, so the model's turn PAUSES on the proposal until the user
 * approves it client-side (the approval card calls the PDP-gated planProject/
 * provisionProject, then feeds the outcome back via `addToolResult`, which resumes the
 * run). The agent must never claim it deployed without approval.
 *
 * `opts.environmentId` is the environment the conversation is scoped to (the project
 * route resolves it). The description names it so the model fills `environmentId` on every
 * proposal — an omitted id reaches the actions as "the project's default environment",
 * which is exactly the wrong target when the user is looking at any other one.
 */
export function operationTools(opts?: { environmentId?: string | null }) {
	const scoped = opts?.environmentId
		? ` This conversation is scoped to environment id ${opts.environmentId}: set environmentId to exactly that id on every proposal (never omit it, never substitute another environment).`
		: "";
	return {
		propose_operation: tool({
			description: BASE_DESCRIPTION + scoped,
			inputSchema: proposeOperationInputSchema,
			// No execute — the user approves client-side; the outcome returns via addToolResult.
		}),
	};
}
