// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { proposeOperationInputSchema } from "../operation";

/**
 * Mutation tools — Act mode only. `propose_operation` EMITS a proposal (it does not
 * execute); the user approves it client-side, which calls the PDP-gated
 * planProject/provisionProject. The agent must never claim it deployed without approval.
 */
export function operationTools() {
	return {
		propose_operation: tool({
			description:
				"Propose a plan or deploy operation on an EXISTING project for the user to APPROVE. Planning queues a PLAN job; deploying provisions LIVE infrastructure — both require this approval, never run without it. After a plan succeeds (check get_plan_result), propose provision_project with its planJobId + the add/change/destroy + monthly stats so the user can review before deploying.",
			inputSchema: proposeOperationInputSchema,
			execute: async ({ label, operation, stats }) => ({
				id: crypto.randomUUID(),
				label,
				operation,
				stats,
			}),
		}),
	};
}
