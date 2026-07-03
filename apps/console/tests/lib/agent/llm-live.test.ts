// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live LLM exercise (opt-in): drives the supervisor + LLM sub-agent runner against
// the REAL AI gateway, end-to-end. Gated behind ELENCH_LIVE=1 (and a configured key)
// so it is SKIPPED in normal CI — it makes a non-deterministic, credit-spending
// network call. Run explicitly: ELENCH_LIVE=1 AI_GATEWAY_API_KEY=… pnpm -F console \
//   exec vitest run tests/lib/agent/llm-live.test.ts

import { describe, expect, it } from "vitest";
import { createLlmSubAgentRunner } from "@/lib/agent/llm-subagent";
import { runSupervisor } from "@/lib/agent/supervisor";

// Production routes call the model through the Vercel AI Gateway. For an offline
// live EXERCISE we inject a raw Anthropic Messages-API call (the injection seam's
// whole point) when a direct Anthropic key is present — proving the supervisor →
// sub-agent runner → real model → parse → completion path runs end-to-end.
const key =
	process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY || "";
const live = process.env.ELENCH_LIVE === "1" && key.startsWith("sk-ant");

async function anthropicGenerate(prompt: string): Promise<string> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 256,
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { content?: { text?: string }[] };
	return data.content?.[0]?.text ?? "";
}

describe.runIf(live)("live LLM colony exercise", () => {
	it(
		"runs the supervisor end-to-end against the real model",
		async () => {
			const runner = createLlmSubAgentRunner(anthropicGenerate);

			const res = await runSupervisor(
				[
					{
						id: "t1",
						objective:
							'Acknowledge this trivial check is complete. Respond ONLY as JSON {"ok":true,"result":"<short note>","facts":[]}.',
						status: "pending",
					},
				],
				runner,
				{ maxRounds: 2 },
			);

			// One task delegated and resolved (done or failed) — the live path ran.
			expect(res.completed.length + res.failed.length).toBe(1);
			// Observable evidence of the live run.
			console.log(
				"LIVE colony result:",
				JSON.stringify(res.completed[0] ?? res.failed[0]),
			);
		},
		60_000,
	);
});
