// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stood-in handlers for the conformance suite: one per declared tool, under the tool's own scope.
// The three tools the spec §4.8 sequence calls answer a fixed result that satisfies the tool's
// declared output schema (the SDK validates structuredContent against it, so an answer that did not
// would fail the call, not the assertion); every other tool refuses.

import { McpToolRefusal, type HandledTool } from "@/lib/ai/mcp/served";
import { listExternalTools } from "@/lib/ai/mcp/surface";

/** The fixed answers of the tools the conformance sequence calls. */
export const STAND_IN_ANSWERS: Readonly<Record<string, Record<string, unknown>>> = {
	validate_design: { valid: true, errors: [] },
	request_apply: {
		approval_id: "appr-1",
		status: "pending",
		approve_url: "https://alethialabs.io/approvals/appr-1",
		digest_prefix: "0123abcd",
		expires_at: "2026-12-01T00:00:00.000Z",
		job_id: null,
	},
	wait_for_job: { subject: "approval", status: "approved", stage: null, done: true, job_id: null, next_poll_s: null },
};

/** A handler for every declared tool: the fixed answer where there is one, else a refusal. */
export function standInHandlers(): Record<string, HandledTool> {
	return Object.fromEntries(
		listExternalTools().map((tool): [string, HandledTool] => [
			tool.name,
			{
				scope: tool.scope,
				call: async () => {
					const answer = STAND_IN_ANSWERS[tool.name];
					if (answer === undefined) throw new McpToolRefusal("not_in_sequence", "Not part of the conformance sequence.");
					return answer;
				},
			},
		]),
	);
}
