// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The behavior eval (Tier B, nightly — NOT a merge gate): does the REAL model still do
// the right thing with our REAL system prompt and our REAL tool definitions?
//
// It asserts the TOOL TRACE, never the prose — "asked about connectors → called
// list_connectors", "asked for a dashboard → called build_dashboard with ≥2 blocks".
// That's the part of model behavior a mock can't prove and a UI assertion can't state
// stably. The tools' `execute` is stubbed with canned data (so no DB/auth is needed),
// but the NAMES, DESCRIPTIONS and INPUT SCHEMAS are the production ones — those are
// exactly what steers the model's choice, so prompt/description regressions get caught.

import { stepCountIs, streamText, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { systemPrompt } from "@/app/api/agent/route";
import { buildAgentTools } from "@/lib/ai/tools";
import { resolveModel } from "@/lib/config/ai";

const MODEL = process.env.AI_EXECUTOR_MODEL || "anthropic/claude-haiku-4-5";
const hasKey = !!process.env.ANTHROPIC_API_KEY;

/** Canned outputs so a tool call resolves without a DB or an authenticated actor. */
const CANNED: Record<string, unknown> = {
	list_connectors: {
		connectors: [
			{ slug: "aws", name: "Amazon Web Services", category: "cloud", status: "active", connected: false },
			{ slug: "gcp", name: "Google Cloud", category: "cloud", status: "active", connected: false },
		],
	},
	list_clusters: { clusters: [] },
	list_jobs: { jobs: [] },
	list_projects: { projects: [] },
	get_org_usage: {
		plan: "community",
		used_minutes: 0,
		included_minutes: 200,
		overage_minutes: 0,
		overage_cost_usd: 0,
		running_jobs: 0,
		max_concurrent_jobs: 2,
	},
};

/**
 * The production tools with their executes swapped for canned data: same names,
 * descriptions and input schemas (what the model actually reasons over), no side
 * effects. Anything without a canned entry returns an empty object.
 */
function evalTools(): ToolSet {
	const real = buildAgentTools({ mode: "ask" });
	const out: ToolSet = {};
	for (const [name, def] of Object.entries(real)) {
		out[name] = {
			...def,
			execute: async () => CANNED[name] ?? {},
		};
	}
	return out;
}

/** Run one turn and return the tool calls the model made (in order). */
async function toolTrace(
	prompt: string,
): Promise<Array<{ toolName: string; input: unknown }>> {
	const result = streamText({
		model: resolveModel(MODEL).model,
		system: systemPrompt("ask"),
		prompt,
		tools: evalTools(),
		stopWhen: stepCountIs(4),
	});
	// Drain the stream so the run completes.
	for await (const _ of result.textStream) {
		// no-op
	}
	const steps = await result.steps;
	return steps.flatMap((s) =>
		s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })),
	);
}

describe.skipIf(!hasKey)("agent behavior (real model)", () => {
	it(
		"reaches for list_connectors when asked about connector health",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("Are my connectors healthy?");
			expect(trace.map((t) => t.toolName)).toContain("list_connectors");
		},
	);

	it(
		"composes a dashboard with build_dashboard when asked for one",
		{ timeout: 180_000 },
		async () => {
			const trace = await toolTrace(
				"Build a dashboard of my infrastructure — clusters, jobs, and runner usage — as stat cards.",
			);
			const names = trace.map((t) => t.toolName);
			// It must have READ something real before composing (no invented data)…
			expect(names.some((n) => n.startsWith("list_") || n.startsWith("get_"))).toBe(
				true,
			);
			// …and then composed the dashboard.
			const build = trace.find((t) => t.toolName === "build_dashboard");
			expect(build, "the model called build_dashboard").toBeDefined();
			const input = build?.input;
			const blocks =
				input && typeof input === "object" && "blocks" in input ? input.blocks : [];
			expect(Array.isArray(blocks) && blocks.length >= 2).toBe(true);
		},
	);

	it(
		"answers a plain question WITHOUT calling tools",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace(
				"In one sentence, what is the difference between a Project and a Cluster in Alethia?",
			);
			expect(trace).toHaveLength(0);
		},
	);
});
