// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The scripted E2E model must be INERT unless ALETHIA_AI_MOCK=1 — a production build
// that quietly answered from the mock would be a silent catastrophe, so the gate is
// asserted here (both directions), alongside the scenario-selection logic the E2E
// specs depend on.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hasToolResult,
	isAiMock,
	lastUserText,
	mockLanguageModel,
	scenarioFor,
	scriptFor,
} from "@/lib/config/ai-mock";
import { isAiConfigured, resolveModel } from "@/lib/config/ai";

const KEY = "anthropic/claude-haiku-4-5";

/** A one-user-message provider prompt. */
function userPrompt(text: string) {
	return [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
}

beforeEach(() => {
	delete process.env.ALETHIA_AI_MOCK;
	delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
	delete process.env.ALETHIA_AI_MOCK;
	delete process.env.ANTHROPIC_API_KEY;
});

describe("the mock gate (production safety)", () => {
	it("is OFF by default — resolveModel returns the real Anthropic provider", () => {
		expect(isAiMock()).toBe(false);
		const resolved = resolveModel(KEY);
		expect(resolved.provider).toBe("anthropic");
		// The real SDK model, not the scripted stand-in.
		expect(resolved.model).not.toHaveProperty("doStreamCalls");
	});

	it("does not fake AI configuration when off (no key → still unconfigured)", () => {
		expect(isAiConfigured()).toBe(false);
	});

	it("ignores any value other than exactly '1'", () => {
		process.env.ALETHIA_AI_MOCK = "true";
		expect(isAiMock()).toBe(false);
		process.env.ALETHIA_AI_MOCK = "0";
		expect(isAiMock()).toBe(false);
	});

	it("engages only with ALETHIA_AI_MOCK=1 — scripted model, no key needed", () => {
		process.env.ALETHIA_AI_MOCK = "1";
		expect(isAiMock()).toBe(true);
		expect(isAiConfigured()).toBe(true);
		const resolved = resolveModel(KEY);
		// MockLanguageModelV3 records its calls — the tell-tale of the stand-in.
		expect(resolved.model).toHaveProperty("doStreamCalls");
		// The canonical key (the ledger/metering key) is preserved.
		expect(resolved.key).toBe(KEY);
	});
});

describe("scenarioFor", () => {
	it("routes each E2E prompt to its script", () => {
		expect(scenarioFor("Are my connectors healthy?")).toBe("connectors");
		expect(scenarioFor("Build a dashboard of my infrastructure")).toBe("dashboard");
		expect(scenarioFor("running jobs")).toBe("pin_widget");
		expect(scenarioFor("edit @prod-overview artifact")).toBe("artifact_edit");
		expect(scenarioFor("deploy the project")).toBe("propose_operation");
		expect(scenarioFor("what is alethia?")).toBe("text");
	});
});

describe("scriptFor", () => {
	it("emits reasoning + a tool call on the planning step", () => {
		const parts = scriptFor(userPrompt("Are my connectors healthy?"));
		expect(parts.map((p) => p.type)).toContain("reasoning-delta");
		const call = parts.find((p) => p.type === "tool-call");
		expect(call).toMatchObject({ toolName: "list_connectors" });
	});

	it("streams a build_dashboard spec with four blocks", () => {
		const parts = scriptFor(userPrompt("build me a dashboard"));
		const call = parts.find((p) => p.type === "tool-call");
		if (!call || call.type !== "tool-call") throw new Error("no tool call");
		const input: unknown = JSON.parse(call.input);
		expect(input).toMatchObject({ title: "Infrastructure Dashboard" });
		expect(
			input && typeof input === "object" && "blocks" in input
				? input.blocks
				: [],
		).toHaveLength(4);
	});

	it("closes with text once the real tool result is back (the executor step)", () => {
		const parts = scriptFor([
			...userPrompt("Are my connectors healthy?"),
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "mock-list_connectors-1",
						toolName: "list_connectors",
						output: { type: "json", value: { connectors: [] } },
					},
				],
			},
		]);
		expect(parts.some((p) => p.type === "tool-call")).toBe(false);
		expect(parts.some((p) => p.type === "text-delta")).toBe(true);
		const finish = parts.find((p) => p.type === "finish");
		expect(finish).toMatchObject({ finishReason: { unified: "stop" } });
	});

	it("edits an artifact as a TWO-tool turn: get_artifact → update_artifact", () => {
		const ask = userPrompt("edit the @prod-overview artifact");
		// Step 0: read it.
		const first = scriptFor(ask);
		const read = first.find((p) => p.type === "tool-call");
		expect(read).toMatchObject({ toolName: "get_artifact" });

		// Step 1: the REAL get_artifact result comes back → write the edited spec.
		const withRead = [
			...ask,
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "mock-get_artifact-1",
						toolName: "get_artifact",
						output: {
							type: "json" as const,
							value: {
								found: true,
								id: "11111111-1111-1111-1111-111111111111",
								name: "prod-overview",
								kind: "dashboard",
								spec: { widgets: [{ kind: "stat" }] },
							},
						},
					},
				],
			},
		];
		const second = scriptFor(withRead);
		const write = second.find((p) => p.type === "tool-call");
		if (!write || write.type !== "tool-call") throw new Error("no update call");
		expect(write.toolName).toBe("update_artifact");
		const input: unknown = JSON.parse(write.input);
		// It targets the id the real tool returned and APPENDS to the real spec.
		expect(input).toMatchObject({
			artifactId: "11111111-1111-1111-1111-111111111111",
		});
		expect(
			input && typeof input === "object" && "spec" in input
				? JSON.stringify(input.spec)
				: "",
		).toContain("Added by Elench");
	});

	it("still calls a tool on a LATER turn of a conversation that already used one", () => {
		// Regression: scoping "has a tool already run?" to the whole prompt made every
		// follow-up turn look like a post-tool step, so the model skipped straight to text
		// and never called the tool (caught by the e2e empty-cell journey).
		const parts = scriptFor([
			...userPrompt("Build a dashboard of my infrastructure"),
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "mock-build_dashboard-1",
						toolName: "build_dashboard",
						output: { type: "json", value: { title: "d", blocks: [] } },
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "Your dashboard is up." }] },
			// A NEW user turn — its tool must still run.
			...userPrompt("running jobs"),
		]);
		const call = parts.find((p) => p.type === "tool-call");
		expect(call).toMatchObject({ toolName: "pin_widget" });
	});

	it("pins to the grid cell the route's hint carries (empty-cell prompt)", () => {
		const parts = scriptFor([
			{
				role: "system",
				content:
					"You are the agent. The user is filling grid cell (x=3, y=2) of the 5-column bento grid.",
			},
			...userPrompt("running jobs"),
		]);
		const call = parts.find((p) => p.type === "tool-call");
		if (!call || call.type !== "tool-call") throw new Error("no tool call");
		expect(JSON.parse(call.input)).toMatchObject({ position: { x: 3, y: 2 } });
	});
});

describe("prompt helpers", () => {
	it("reads the last user message and detects follow-up steps", () => {
		expect(lastUserText(userPrompt("hello"))).toBe("hello");
		expect(hasToolResult(userPrompt("hello"))).toBe(false);
	});

	it("builds a streaming model whose calls are observable", async () => {
		const model = mockLanguageModel("claude-haiku-4-5");
		const { stream } = await model.doStream({
			prompt: userPrompt("Are my connectors healthy?"),
			includeRawChunks: false,
		});
		const types: string[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			types.push(value.type);
		}
		expect(types).toContain("tool-call");
		expect(model.doStreamCalls).toHaveLength(1);
	});
});
