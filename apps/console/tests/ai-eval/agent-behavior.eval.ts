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
//
// The AI soak (e2e-ai-soak.yml, until 2026-12-12) runs this file once per model the product can
// route to — Haiku as the executor, Sonnet and Opus as the advisors — by setting
// AI_EXECUTOR_MODEL. Each case accepts the SET of tools that would be a correct answer, not one
// exact tool: a stronger model that reads more before it acts is not a regression. When
// AI_EVAL_USAGE_FILE is set, the token usage and cost of every case is written there for the job
// summary, priced by the same table that prices the product's ledger.

import { writeFile } from "node:fs/promises";
import { stepCountIs, streamText, type ToolSet } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { systemPrompt } from "@/app/api/agent/route";
import { buildAgentTools, type AgentMode } from "@/lib/ai/tools";
import { aiCostUsd } from "@/lib/billing/model-costs";
import { resolveModel } from "@/lib/config/ai";

const MODEL = process.env.AI_EXECUTOR_MODEL || "anthropic/claude-haiku-4-5";
const hasKey = !!process.env.ANTHROPIC_API_KEY;

const PROJECT_ID = "6f1c2a8e-0000-4000-8000-000000000001";
const ENV_ID = "6f1c2a8e-0000-4000-8000-000000000002";

/** Canned outputs so a tool call resolves without a DB or an authenticated actor. */
const CANNED: Record<string, unknown> = {
	list_connectors: {
		connectors: [
			{ slug: "aws", name: "Amazon Web Services", category: "cloud", status: "active", connected: false },
			{ slug: "gcp", name: "Google Cloud", category: "cloud", status: "active", connected: false },
		],
	},
	list_clusters: { clusters: [] },
	list_jobs: {
		jobs: [
			{ id: "job-1", kind: "deploy", status: "failed", project: "shop", error: "quota exceeded", created_at: "2026-11-25T10:00:00Z" },
			{ id: "job-2", kind: "plan", status: "succeeded", project: "shop", created_at: "2026-11-25T09:00:00Z" },
		],
	},
	list_projects: {
		projects: [{ id: PROJECT_ID, name: "shop", provider: "aws", environments: [{ id: ENV_ID, name: "production" }] }],
	},
	get_project: {
		id: PROJECT_ID,
		name: "shop",
		provider: "aws",
		environments: [{ id: ENV_ID, name: "production" }],
		components: [{ kind: "kubernetes", size: "small" }, { kind: "database", engine: "postgres" }],
	},
	list_runners: {
		runners: [
			{ id: "r-1", name: "eu-runner", status: "online", last_seen: "2026-11-26T08:00:00Z" },
			{ id: "r-2", name: "us-runner", status: "offline", last_seen: "2026-11-20T08:00:00Z" },
		],
	},
	get_drift_posture: { status: "ok", in_sync: false, drifted: 1, details: [{ resource: "aws_security_group.web", change: "ingress rule added" }] },
	get_org_usage: {
		plan: "community",
		used_minutes: 0,
		included_minutes: 200,
		overage_minutes: 0,
		overage_cost_usd: 0,
		running_jobs: 0,
		max_concurrent_jobs: 2,
	},
	get_ai_usage: { tier: "ai_plus", used_credits: 1200, weekly_credits: 15000, session_credits_used: 300 },
	get_billing_summary: { plan: "team", status: "active", seats: 3, current_period_end: "2026-12-20" },
	list_cloud_identities: { identities: [] },
	search_docs: {
		results: [{ title: "Connect Google Cloud (keyless)", url: "/docs/connectors/gcp", excerpt: "Create a workload identity pool that trusts Alethia's OIDC issuer…" }],
	},
	connect_cloud: { action: "connect", provider: "aws", connected: false },
};

/**
 * The production tools for `mode` with their executes swapped for canned data: same names,
 * descriptions and input schemas (what the model actually reasons over), no side effects.
 * Anything without a canned entry returns an empty object; a tool with NO execute (a HITL
 * proposal such as `propose_operation`) keeps none, so the turn pauses there as it does live.
 */
function evalTools(mode: AgentMode): ToolSet {
	const real = buildAgentTools({ mode });
	const out: ToolSet = {};
	for (const [name, def] of Object.entries(real)) {
		out[name] = "execute" in def && def.execute
			? { ...def, execute: async () => CANNED[name] ?? {} }
			: def;
	}
	return out;
}

interface CaseUsage {
	name: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	costUsd: number;
}

const usage: CaseUsage[] = [];

/** Run one turn and return the tool calls the model made (in order), recording its usage. */
async function toolTrace(
	name: string,
	prompt: string,
	mode: AgentMode = "ask",
): Promise<Array<{ toolName: string; input: unknown }>> {
	const result = streamText({
		model: resolveModel(MODEL).model,
		system: systemPrompt(mode),
		prompt,
		tools: evalTools(mode),
		stopWhen: stepCountIs(4),
	});
	// Drain the stream so the run completes.
	for await (const _ of result.textStream) {
		// no-op
	}
	const steps = await result.steps;
	const u = steps.reduce(
		(acc, s) => ({
			inputTokens: acc.inputTokens + (s.usage.inputTokens ?? 0),
			cachedInputTokens: acc.cachedInputTokens + (s.usage.cachedInputTokens ?? 0),
			outputTokens: acc.outputTokens + (s.usage.outputTokens ?? 0),
		}),
		{ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
	);
	usage.push({ name, ...u, costUsd: Number(aiCostUsd({ model: MODEL, ...u }).toFixed(4)) });
	return steps.flatMap((s) =>
		s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })),
	);
}

/** The tool names of a trace. */
function names(trace: Array<{ toolName: string }>): string[] {
	return trace.map((t) => t.toolName);
}

/** The value of `key` on a tool input, when the input is an object carrying it. */
function inputField(input: unknown, key: string): unknown {
	if (input && typeof input === "object" && key in input) {
		return Object.getOwnPropertyDescriptor(input, key)?.value;
	}
	return undefined;
}

afterAll(async () => {
	const file = process.env.AI_EVAL_USAGE_FILE;
	if (!file || usage.length === 0) return;
	const totalCostUsd = Number(usage.reduce((s, c) => s + c.costUsd, 0).toFixed(4));
	await writeFile(file, JSON.stringify({ model: MODEL, cases: usage, totalCostUsd }, null, 2));
});

describe.skipIf(!hasKey)(`agent behavior (real model · ${MODEL})`, () => {
	it(
		"reaches for list_connectors when asked about connector health",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("connectors", "Are my connectors healthy?");
			expect(names(trace)).toContain("list_connectors");
		},
	);

	it(
		"composes a dashboard with build_dashboard when asked for one",
		{ timeout: 180_000 },
		async () => {
			const trace = await toolTrace(
				"dashboard",
				"Build a dashboard of my infrastructure — clusters, jobs, and runner usage — as stat cards.",
			);
			const called = names(trace);
			// It must have READ something real before composing (no invented data)…
			expect(called.some((n) => n.startsWith("list_") || n.startsWith("get_"))).toBe(true);
			// …and then composed the dashboard.
			const build = trace.find((t) => t.toolName === "build_dashboard");
			expect(build, "the model called build_dashboard").toBeDefined();
			const blocks = inputField(build?.input, "blocks");
			expect(Array.isArray(blocks) && blocks.length >= 2).toBe(true);
		},
	);

	it(
		"answers a plain question WITHOUT calling tools",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace(
				"plain-question",
				"In one sentence, what is the difference between a Project and a Cluster in Alethia?",
			);
			expect(trace).toHaveLength(0);
		},
	);

	it(
		"grounds a how-to answer in the docs (search_docs) rather than guessing",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("docs-howto", "How do I connect my Google Cloud project to Alethia?");
			// The prompt says to GROUND how-to answers with search_docs; offering the one-click connect
			// is also correct, so either satisfies the case — guessing with no tool does not.
			expect(names(trace).some((n) => n === "search_docs" || n === "connect_cloud")).toBe(true);
		},
	);

	it(
		"surfaces the one-click connect action when asked to connect a cloud",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("connect-cloud", "Connect my AWS account.");
			const connect = trace.find((t) => t.toolName === "connect_cloud");
			expect(connect, "the model called connect_cloud").toBeDefined();
			expect(inputField(connect?.input, "provider")).toBe("aws");
		},
	);

	it(
		"reads the AI allowance with get_ai_usage",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("ai-usage", "How much of my AI allowance have I used this week?");
			expect(names(trace)).toContain("get_ai_usage");
		},
	);

	it(
		"reads the plan and bill with a billing read",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("billing", "What plan is my organization on, and when does the billing period end?");
			expect(names(trace).some((n) => n === "get_billing_summary" || n === "get_org_usage")).toBe(true);
		},
	);

	it(
		"finds failed jobs with list_jobs",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("failed-jobs", "Did any of my deploy jobs fail recently? Why?");
			expect(names(trace)).toContain("list_jobs");
		},
	);

	it(
		"checks runner health with list_runners",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("runners", "Are any of my runners offline?");
			expect(names(trace)).toContain("list_runners");
		},
	);

	it(
		"sizes a network with cidr_for_hosts and passes the cloud",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("cidr", "What CIDR block do I need for about 500 hosts on AWS?");
			const cidr = trace.find((t) => t.toolName === "cidr_for_hosts");
			expect(cidr, "the model called cidr_for_hosts").toBeDefined();
			// The prompt says ALWAYS pass `cloud` once known — without it the answer is widened.
			expect(inputField(cidr?.input, "cloud")).toBe("aws");
		},
	);

	it(
		"checks drift with get_drift_posture on a real project id",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("drift", "Has anything in my shop project drifted from what was provisioned?");
			const drift = trace.find((t) => t.toolName === "get_drift_posture");
			expect(drift, "the model called get_drift_posture").toBeDefined();
			// "Never invent ids": the id must be the one list_projects/get_project returned.
			expect(inputField(drift?.input, "projectId")).toBe(PROJECT_ID);
		},
	);

	it(
		"in ACT mode, proposes a plan (propose_operation) for an existing project — never claims it ran",
		{ timeout: 180_000 },
		async () => {
			const trace = await toolTrace(
				"act-plan",
				"Plan the production environment of my shop project.",
				"act",
			);
			const propose = trace.find((t) => t.toolName === "propose_operation");
			expect(propose, "the model called propose_operation").toBeDefined();
			// The project id sits inside `operation` (lib/ai/operation.ts); assert it is the real one
			// list_projects returned, wherever the schema nests it.
			expect(JSON.stringify(propose?.input ?? null)).toContain(PROJECT_ID);
			// A plan is proposed for approval; the apply is a separate, later request.
			expect(names(trace)).not.toContain("request_apply");
		},
	);

	it(
		"in ASK mode, has no operation tools to reach for",
		{ timeout: 120_000 },
		async () => {
			const trace = await toolTrace("ask-deploy", "Deploy my shop project to production now.");
			const ops = ["propose_operation", "request_apply", "request_destroy"];
			expect(names(trace).filter((n) => ops.includes(n))).toEqual([]);
		},
	);
});
