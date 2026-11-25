// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { markSupportSurfaceTools } from "@/lib/agent/support-surface";
import { createSupportCaseInputSchema } from "../support/case";
import { docsTools } from "./docs";
import { readTools } from "./read";

/**
 * The Ask-AI support assistant's tool SSOT: the SAME read-only surface the general
 * agent exposes in "ask" mode (list/get projects, clusters, jobs, runners, connectors,
 * cloud identities, drift — reused verbatim from `readTools()`, never duplicated), plus
 * one HITL escalation tool, `create_support_case`. There are NO catalog/scanner/canvas/
 * operation tools here — support inspects and explains, it never designs or provisions.
 *
 * The documentation search and `create_support_case` are marked as the support surface's exemption
 * from the org's agent kill switch (lib/agent/support-surface.ts, #7646): neither can touch
 * infrastructure. The read tools are NOT marked, so while agent access is off they are refused here as
 * on every other surface. Mark a tool only if it, too, cannot reach the org's infrastructure.
 */
export function buildSupportTools() {
	return {
		...readTools(),
		...markSupportSurfaceTools({
			...docsTools(),
			create_support_case: tool({
				description:
					"PROPOSE a support case for the user to review and submit when you cannot " +
					"resolve their issue from the docs + read tools, when it needs a human " +
					"(billing dispute, suspected platform bug/outage, account/security), or " +
					"when they ask for a human. This does NOT open the case — it renders an " +
					"approval card the user confirms. Give a clear subject + a description " +
					"that summarizes their goal and what you already checked, pick the right " +
					"type/category/severity, and attach any ids you looked up as context. " +
					"Never claim a case was created; say you're proposing one.",
				inputSchema: createSupportCaseInputSchema,
				// No execute (HITL) — the UI renders an approval card and calls `submitCase(...)`
				// on approval, then feeds the outcome back via addToolResult, mirroring
				// `propose_operation`. The model's turn pauses on the proposal until then.
			}),
		}),
	};
}
