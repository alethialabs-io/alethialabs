// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the Anthropic-native providerOptions helpers (lib/ai/provider-options):
// the prompt-caching system-message wrapper and the per-model extended-thinking options
// (adaptive for Sonnet/Opus, fixed budget for Haiku, none for non-Anthropic).

import { describe, expect, it } from "vitest";
import {
	cachedSystemMessage,
	thinkingOptions,
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

describe("thinkingOptions", () => {
	it("enables adaptive thinking for Sonnet/Opus (the tier advisors)", () => {
		expect(thinkingOptions(SONNET)).toEqual({
			anthropic: { thinking: { type: "adaptive" } },
		});
		expect(thinkingOptions(OPUS)).toEqual({
			anthropic: { thinking: { type: "adaptive" } },
		});
	});

	it("gives Haiku a bounded fixed budget (no adaptive support) — the free tier thinks too", () => {
		expect(thinkingOptions(HAIKU)).toEqual({
			anthropic: { thinking: { type: "enabled", budgetTokens: 3072 } },
		});
	});

	it("is undefined for a non-Anthropic model (thinking is Anthropic-only)", () => {
		expect(thinkingOptions(OPENAI)).toBeUndefined();
	});
});
