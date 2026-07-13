// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The E2E model mock: a scripted LanguageModel that stands in for the provider so the
// FULL agent pipeline can be tested without an API key or a nondeterministic model.
// Everything downstream of the model is real — the agent route (thinking options,
// orchestration markers, metering, transcript persistence), the SSE wire, the tool
// executes (PDP-gated reads against the real DB), widget auto-pin, artifacts, RLS.
//
// Engaged ONLY when `ALETHIA_AI_MOCK=1` (set by the E2E web server). Inert otherwise:
// `resolveModel` never calls into here and no scenario can run — asserted by a unit
// test so the gate can never silently flip on in production.

import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type {
	LanguageModelV3CallOptions,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { env } from "next-runtime-env";
import { z } from "zod";

/** Whether the scripted E2E model is engaged (never true in a real deployment). */
export function isAiMock(): boolean {
	return env("ALETHIA_AI_MOCK") === "1";
}

/** The scripted turns, keyed by intent detected in the user's message. */
export type MockScenario =
	| "connectors"
	| "dashboard"
	| "pin_widget"
	| "artifact_edit"
	| "propose_operation"
	| "text";

/** Zero token usage — the metering ledger still runs, it just records a free turn. */
const USAGE = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const STOP: LanguageModelV3FinishReason = { unified: "stop", raw: "end_turn" };
const TOOL_CALLS: LanguageModelV3FinishReason = {
	unified: "tool-calls",
	raw: "tool_use",
};

/**
 * Pick the scenario from the user's latest message. Deliberately keyword-based (not a
 * model): E2E specs phrase their prompts to select a script, and anything unmatched
 * falls back to a plain text turn.
 */
export function scenarioFor(text: string): MockScenario {
	const t = text.toLowerCase();
	if (t.includes("artifact") && (t.includes("edit") || t.includes("add"))) {
		return "artifact_edit";
	}
	if (t.includes("dashboard")) return "dashboard";
	if (t.includes("connector")) return "connectors";
	if (t.includes("deploy") || t.includes("plan the project")) {
		return "propose_operation";
	}
	// Everything typed into an empty grid cell asks for one widget.
	if (t.includes("jobs") || t.includes("clusters") || t.includes("usage")) {
		return "pin_widget";
	}
	return "text";
}

/** The last user message's text in a provider prompt (the scenario key). */
export function lastUserText(prompt: LanguageModelV3CallOptions["prompt"]): string {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i];
		if (m?.role !== "user") continue;
		return m.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join(" ");
	}
	return "";
}

/** Whether THIS turn already ran a tool — i.e. we're on a follow-up step. */
export function hasToolResult(prompt: LanguageModelV3CallOptions["prompt"]): boolean {
	return toolsAlreadyRun(prompt).length > 0;
}

/**
 * The tools whose results are already back **in the current turn** (they drive the
 * multi-step scenarios). Scoped to the messages AFTER the last user message: earlier
 * turns in a long conversation carry their own tool results, and counting those would
 * make every follow-up turn think its tool had already run — so it would skip straight
 * to the closing text and never call a tool at all.
 */
export function toolsAlreadyRun(
	prompt: LanguageModelV3CallOptions["prompt"],
): string[] {
	const lastUser = prompt.map((m) => m.role).lastIndexOf("user");
	const names: string[] = [];
	for (const m of prompt.slice(lastUser + 1)) {
		if (m.role !== "tool" && m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "tool-result") names.push(c.toolName);
		}
	}
	return names;
}

/** Reasoning + text + finish parts (the closing beat of every scripted turn). */
function speak(text: string, reasoning?: string): LanguageModelV3StreamPart[] {
	const parts: LanguageModelV3StreamPart[] = [
		{ type: "stream-start", warnings: [] },
	];
	if (reasoning) {
		parts.push(
			{ type: "reasoning-start", id: "r1" },
			{ type: "reasoning-delta", id: "r1", delta: reasoning },
			{ type: "reasoning-end", id: "r1" },
		);
	}
	parts.push({ type: "text-start", id: "t1" });
	for (const chunk of text.match(/.{1,24}/g) ?? [text]) {
		parts.push({ type: "text-delta", id: "t1", delta: chunk });
	}
	parts.push(
		{ type: "text-end", id: "t1" },
		{ type: "finish", finishReason: STOP, usage: USAGE },
	);
	return parts;
}

/**
 * A tool call, streamed the way a real provider does: input deltas under the SAME id as
 * the eventual `toolCallId` (they must match — the SDK keys the streaming part by that
 * id, and a mismatch strands a half-built "Pending" tool part in the transcript), then
 * the call itself.
 */
function callTool(
	toolName: string,
	input: unknown,
	reasoning: string,
): LanguageModelV3StreamPart[] {
	const json = JSON.stringify(input);
	const toolCallId = `mock-${toolName}-1`;
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "reasoning-start", id: "r1" },
		{ type: "reasoning-delta", id: "r1", delta: reasoning },
		{ type: "reasoning-end", id: "r1" },
		{ type: "tool-input-start", id: toolCallId, toolName },
		{ type: "tool-input-delta", id: toolCallId, delta: json },
		{ type: "tool-input-end", id: toolCallId },
		{ type: "tool-call", toolCallId, toolName, input: json },
		{ type: "finish", finishReason: TOOL_CALLS, usage: USAGE },
	];
}

/** The dashboard the `dashboard` scenario composes (4 blocks → 4 grid widgets). */
const DASHBOARD_SPEC = {
	title: "Infrastructure Dashboard",
	blocks: [
		{ kind: "stat", title: "Active clusters", value: 0, sub: "No provisioned clusters" },
		{ kind: "stat", title: "Recent jobs", value: 0, sub: "No provisioning activity" },
		{ kind: "grid", title: "Plan & concurrency", cells: [{ label: "Plan", value: "Community" }] },
		{ kind: "bar", title: "Runner minutes", data: [{ label: "used", value: 0 }, { label: "included", value: 200 }] },
	],
};

/**
 * The scripted stream for one model step. Step 0 of a tool scenario emits the tool
 * call; once the (real) tool result is back in the prompt, the next step closes with
 * text — exactly the shape of a real multi-step agent turn, so the orchestration
 * markers, per-step metering, and transcript persistence all exercise for real.
 */
export function scriptFor(
	prompt: LanguageModelV3CallOptions["prompt"],
): LanguageModelV3StreamPart[] {
	const scenario = scenarioFor(lastUserText(prompt));
	const ran = toolsAlreadyRun(prompt);
	const followUp = ran.length > 0;

	if (scenario === "text") {
		return speak(
			"Alethia provisions infrastructure as Projects, applied by runners via OpenTofu.",
			"Straightforward question — answer from the system prompt, no tools needed.",
		);
	}

	// Editing an artifact is a TWO-tool turn: read it, then write the new spec back —
	// both real server calls, exactly as a real model would sequence them.
	if (
		scenario === "artifact_edit" &&
		ran.includes("get_artifact") &&
		!ran.includes("update_artifact")
	) {
		return callTool(
			"update_artifact",
			{
				artifactId: artifactIdFrom(prompt),
				spec: editedSpecFrom(prompt),
			},
			"Add a widget to the artifact's spec and write it back.",
		);
	}

	if (followUp) {
		// Second (executor) step: summarize what the real tool returned.
		const closing: Record<Exclude<MockScenario, "text">, string> = {
			connectors: "Here are your connectors and their health.",
			dashboard: "Your dashboard is on the grid — clusters, jobs, plan, and runner minutes.",
			pin_widget: "Pinned that to the grid.",
			artifact_edit: "Updated the artifact — the grid is in sync.",
			propose_operation: "Proposed the operation — approve it to run.",
		};
		return speak(closing[scenario]);
	}

	switch (scenario) {
		case "connectors":
			return callTool("list_connectors", {}, "Read the connector health for this org.");
		case "dashboard":
			return callTool(
				"build_dashboard",
				DASHBOARD_SPEC,
				"Compose a dashboard from the org's infrastructure state.",
			);
		case "pin_widget":
			return callTool(
				"pin_widget",
				{
					title: "Jobs",
					kind: "stat",
					block: { kind: "stat", title: "Jobs", value: 0, sub: "No provisioning activity" },
					position: mockCellTarget(prompt),
					size: { colspan: 1, rowspan: 1 },
				},
				"Pin one widget to the requested grid cell.",
			);
		case "artifact_edit":
			return callTool(
				"get_artifact",
				{ idOrName: artifactNameFrom(lastUserText(prompt)) },
				"Load the referenced artifact before editing it.",
			);
		case "propose_operation":
			return callTool(
				"propose_operation",
				{ kind: "plan_project", projectId: "mock", label: "Plan the project" },
				"Propose the operation for the user to approve.",
			);
	}
}

/**
 * The grid cell an empty-cell prompt asked to fill. The route appends a hint carrying
 * the coordinates, so the scripted model "reads" them the way a real model would.
 */
function mockCellTarget(
	prompt: LanguageModelV3CallOptions["prompt"],
): { x: number; y: number } {
	const system = prompt.find((m) => m.role === "system");
	const text = system && typeof system.content === "string" ? system.content : "";
	const m = text.match(/grid cell \(x=(\d+), y=(\d+)\)/);
	return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

/** The artifact an "edit @name" message referenced (the @-token, else the last word). */
function artifactNameFrom(text: string): string {
	const at = text.match(/@([\w-]+)/);
	if (at?.[1]) return at[1];
	const words = text.trim().split(/\s+/);
	return words[words.length - 1] ?? "";
}

/** The `get_artifact` result the REAL tool just returned (a JSON tool-result part). */
const getArtifactOutput = z.object({
	found: z.literal(true),
	id: z.string(),
	spec: z.object({ widgets: z.array(z.unknown()) }),
});

/** Parse the loaded artifact out of the prompt's newest get_artifact result. */
function loadedArtifact(
	prompt: LanguageModelV3CallOptions["prompt"],
): z.infer<typeof getArtifactOutput> | null {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i];
		if (!m || (m.role !== "tool" && m.role !== "assistant")) continue;
		for (const c of m.content) {
			if (c.type !== "tool-result" || c.toolName !== "get_artifact") continue;
			if (c.output.type !== "json") continue;
			const parsed = getArtifactOutput.safeParse(c.output.value);
			if (parsed.success) return parsed.data;
		}
	}
	return null;
}

/** The id the update must target (from what the real get_artifact returned). */
function artifactIdFrom(prompt: LanguageModelV3CallOptions["prompt"]): string {
	return loadedArtifact(prompt)?.id ?? "00000000-0000-0000-0000-000000000000";
}

/** The edited spec: the artifact's real widgets plus one appended stat widget. */
function editedSpecFrom(prompt: LanguageModelV3CallOptions["prompt"]): unknown {
	const existing = loadedArtifact(prompt)?.spec.widgets ?? [];
	return {
		widgets: [
			...existing,
			{
				kind: "stat",
				title: "Added by Elench",
				source: null,
				data: { block: { kind: "stat", title: "Added by Elench", value: 1 } },
				mode: "frozen",
				position: { x: 4, y: 0 },
				size: { colspan: 1, rowspan: 1 },
			},
		],
	};
}

/**
 * The scripted stand-in for a provider model. `doStream` plays the scenario matching
 * the conversation; `simulateReadableStream` paces the parts so the UI's streaming
 * states (reasoning shimmer, running tool marker) are actually observable in a browser.
 */
export function mockLanguageModel(modelId: string): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		provider: "alethia-e2e-mock",
		modelId,
		doStream: async ({ prompt }) => ({
			stream: simulateReadableStream({
				chunks: scriptFor(prompt),
				initialDelayInMs: 10,
				chunkDelayInMs: 10,
			}),
		}),
	});
}
