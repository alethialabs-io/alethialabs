// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { proposeOperationInputSchema } from "../operation";

/**
 * Mutation tools — Act mode only. `propose_operation` is a HITL (human-in-the-loop)
 * tool: it has NO `execute`, so the model's turn PAUSES on the proposal until the user
 * approves it client-side (the approval card calls the PDP-gated planProject/
 * provisionProject, then feeds the outcome back via `addToolResult`, which resumes the
 * run). The agent must never claim it deployed without approval.
 */
export function operationTools() {
	return {
		propose_operation: tool({
			description:
				"Propose a plan or deploy operation on an EXISTING project for the user to APPROVE. Planning queues a PLAN job; deploying provisions LIVE infrastructure — both require this approval, never run without it. After a plan succeeds (check get_plan_result), propose provision_project with its planJobId + the add/change/destroy + monthly stats so the user can review before deploying.",
			inputSchema: proposeOperationInputSchema,
			// No execute — the user approves client-side; the outcome returns via addToolResult.
		}),
	};
}
