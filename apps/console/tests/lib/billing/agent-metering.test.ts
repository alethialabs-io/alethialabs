// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-model agent metering (lib/billing/agent-metering.ts). Asserts the pure step→model
// aggregation and that recordAgentTurnUsage books the credit charge exactly once (first
// model) while recording every other model as a cost-only row — so advisor + executor cost
// is visible without double-charging the credit budget.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/ai-quota", () => ({ recordAiUsage: vi.fn() }));

import {
	aggregateUsageByModel,
	recordAgentTurnUsage,
} from "@/lib/billing/agent-metering";
import { recordAiUsage } from "@/lib/billing/ai-quota";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";

beforeEach(() => vi.clearAllMocks());

describe("aggregateUsageByModel", () => {
	it("sums tokens per distinct model, preserving first-appearance order", () => {
		const out = aggregateUsageByModel([
			{ model: SONNET, usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 } },
			{ model: HAIKU, usage: { inputTokens: 200, outputTokens: 60 } },
			{ model: HAIKU, usage: { inputTokens: 50, outputTokens: 20, cachedInputTokens: 5 } },
		]);
		expect(out).toEqual([
			{ model: SONNET, inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 },
			{ model: HAIKU, inputTokens: 250, outputTokens: 80, cachedInputTokens: 5 },
		]);
	});

	it("returns a single record for a one-model turn", () => {
		const out = aggregateUsageByModel([
			{ model: HAIKU, usage: { inputTokens: 10, outputTokens: 5 } },
			{ model: HAIKU, usage: { inputTokens: 10, outputTokens: 5 } },
		]);
		expect(out).toEqual([
			{ model: HAIKU, inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 },
		]);
	});

	it("is empty for an empty turn", () => {
		expect(aggregateUsageByModel([])).toEqual([]);
	});
});

describe("recordAgentTurnUsage", () => {
	it("charges credits once (first model) and records the rest as cost-only rows", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", credits: 1 },
			refId: "thread-1",
			steps: [
				{ model: SONNET, usage: { inputTokens: 100, outputTokens: 40 } }, // advisor (step 0)
				{ model: HAIKU, usage: { inputTokens: 300, outputTokens: 80 } }, // executor
				{ model: HAIKU, usage: { inputTokens: 120, outputTokens: 30 } }, // executor
			],
		});

		expect(recordAiUsage).toHaveBeenCalledTimes(2); // one row per distinct model
		// First model (advisor) carries the single credit charge.
		expect(recordAiUsage).toHaveBeenNthCalledWith(1, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			credits: 1,
			source: "included",
			refId: "thread-1",
			model: SONNET,
			inputTokens: 100,
			outputTokens: 40,
			cachedInputTokens: 0,
		});
		// Executor is a cost-only row (credits 0) with summed tokens.
		expect(recordAiUsage).toHaveBeenNthCalledWith(2, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			credits: 0,
			source: "included",
			refId: "thread-1",
			model: HAIKU,
			inputTokens: 420,
			outputTokens: 110,
			cachedInputTokens: 0,
		});
	});

	it("books the full charge on the single row for a one-model turn", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "purchased", credits: 1 },
			steps: [{ model: HAIKU, usage: { inputTokens: 10, outputTokens: 5 } }],
		});
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
		expect(recordAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ model: HAIKU, credits: 1, source: "purchased" }),
		);
	});
});
