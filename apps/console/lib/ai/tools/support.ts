// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { createSupportCaseInputSchema } from "../support/case";
import { readTools } from "./read";

/**
 * The Ask-AI support assistant's tool SSOT: the SAME read-only surface the general
 * agent exposes in "ask" mode (list/get projects, clusters, jobs, runners, connectors,
 * cloud identities, drift — reused verbatim from `readTools()`, never duplicated), plus
 * one HITL escalation tool, `create_support_case`. There are NO catalog/scanner/canvas/
 * operation tools here — support inspects and explains, it never designs or provisions.
 */
export function buildSupportTools() {
	return {
		...readTools(),

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
			// Emits the proposal (does not write) — the UI renders an approval card and
			// calls `submitCase(...)` on approval, mirroring `propose_operation`.
			execute: async (input) => ({ id: crypto.randomUUID(), ...input }),
		}),
	};
}
