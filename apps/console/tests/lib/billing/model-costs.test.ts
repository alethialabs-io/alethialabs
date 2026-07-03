// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { aiCostMicros, aiCostUsd, modelPrice } from "@/lib/billing/model-costs";

describe("modelPrice", () => {
	it("returns list pricing for a known model", () => {
		expect(modelPrice("anthropic/claude-sonnet-4.6")).toEqual({
			inputPerMTok: 3,
			outputPerMTok: 15,
		});
	});

	it("falls back to Sonnet-tier for an unknown model (never $0)", () => {
		const p = modelPrice("some/unknown-model");
		expect(p.inputPerMTok).toBeGreaterThan(0);
		expect(p.outputPerMTok).toBeGreaterThan(0);
	});
});

describe("aiCostUsd", () => {
	const M = 1_000_000;

	it("bills input/output at the per-MTok rate", () => {
		expect(aiCostUsd({ model: "anthropic/claude-sonnet-4.6", inputTokens: M })).toBeCloseTo(3);
		expect(aiCostUsd({ model: "anthropic/claude-sonnet-4.6", outputTokens: M })).toBeCloseTo(15);
	});

	it("bills cache-read input at ~10% of the input rate", () => {
		expect(
			aiCostUsd({ model: "anthropic/claude-sonnet-4.6", cachedInputTokens: M }),
		).toBeCloseTo(0.3);
	});

	it("sums the three token buckets", () => {
		// 1M uncached ($3) + 1M cached ($0.3) + 1M output ($15) = $18.3
		expect(
			aiCostUsd({
				model: "anthropic/claude-sonnet-4.6",
				inputTokens: M,
				cachedInputTokens: M,
				outputTokens: M,
			}),
		).toBeCloseTo(18.3);
	});

	it("is zero when no tokens were used", () => {
		expect(aiCostUsd({ model: "anthropic/claude-sonnet-4.6" })).toBe(0);
	});

	it("uses the more expensive Opus rate", () => {
		const sonnet = aiCostUsd({ model: "anthropic/claude-sonnet-4.6", outputTokens: M });
		const opus = aiCostUsd({ model: "anthropic/claude-opus-4.8", outputTokens: M });
		expect(opus).toBeGreaterThan(sonnet);
	});
});

describe("aiCostMicros", () => {
	it("converts to integer USD micros", () => {
		// $3 → 3,000,000 micros
		expect(aiCostMicros({ model: "anthropic/claude-sonnet-4.6", inputTokens: 1_000_000 })).toBe(
			3_000_000,
		);
	});

	it("rounds to the nearest micro", () => {
		const v = aiCostMicros({ model: "anthropic/claude-sonnet-4.6", inputTokens: 1 });
		expect(Number.isInteger(v)).toBe(true);
	});
});
