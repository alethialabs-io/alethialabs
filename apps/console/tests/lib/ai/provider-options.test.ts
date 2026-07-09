// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the Anthropic-native providerOptions helpers (lib/ai/provider-options):
// the prompt-caching system-message wrapper and the advisor-step adaptive-thinking gate.

import { describe, expect, it } from "vitest";
import {
	advisorThinkingOptions,
	cachedSystemMessage,
} from "@/lib/ai/provider-options";
import { resolveModel } from "@/lib/config/ai";

const HAIKU = resolveModel("anthropic/claude-haiku-4-5");
const SONNET = resolveModel("anthropic/claude-sonnet-4-6");
const OPUS = resolveModel("anthropic/claude-opus-4-8");
const OPENAI = resolveModel("openai/gpt-5-mini");

describe("cachedSystemMessage", () => {
	it("wraps the prompt as a system message with an Anthropic ephemeral cache breakpoint", () => {
		const msg = cachedSystemMessage("stable system prompt");
		expect(msg.role).toBe("system");
		expect(msg.content).toBe("stable system prompt");
		expect(msg.providerOptions?.anthropic?.cacheControl).toEqual({
			type: "ephemeral",
		});
	});
});

describe("advisorThinkingOptions", () => {
	it("enables adaptive thinking for a distinct Anthropic advisor (plus/max)", () => {
		expect(advisorThinkingOptions(SONNET, HAIKU)).toEqual({
			anthropic: { thinking: { type: "adaptive" } },
		});
		expect(advisorThinkingOptions(OPUS, HAIKU)).toEqual({
			anthropic: { thinking: { type: "adaptive" } },
		});
	});

	it("is undefined when the advisor IS the executor (ai_free — no distinct advisor)", () => {
		expect(advisorThinkingOptions(HAIKU, HAIKU)).toBeUndefined();
	});

	it("is undefined for a non-Anthropic advisor (thinking is Anthropic-only)", () => {
		expect(advisorThinkingOptions(OPENAI, HAIKU)).toBeUndefined();
	});
});
