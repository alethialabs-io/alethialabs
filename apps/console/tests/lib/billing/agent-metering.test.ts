// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-model agent metering (lib/billing/agent-metering.ts). Asserts the pure step→model
// aggregation and that recordAgentTurnUsage:
//  - SETTLE charge (metered, the norm): omits `credits` on EVERY model row (each row's
//    cost-weighted credits are derived from its own cost_micros) and threads the source. The
//    turn's reserved hold is RECONCILED on the first model row (holdId → UPDATE) and later rows
//    append; an empty turn (no steps) RELEASES the hold to 0 so it never leaks headroom.
//  - FIXED charge (reservation): books the credit charge once on the first model row and
//    records the rest as cost-only rows — no double-charge.

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

describe("recordAgentTurnUsage — settle (metered) charge", () => {
	it("omits credits on EVERY model row (each derives its own cost) and threads the source", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", settle: true, holdId: "hold-1" },
			refId: "thread-1",
			steps: [
				{ model: SONNET, usage: { inputTokens: 100, outputTokens: 40 } }, // advisor (step 0)
				{ model: HAIKU, usage: { inputTokens: 300, outputTokens: 80 } }, // executor
				{ model: HAIKU, usage: { inputTokens: 120, outputTokens: 30 } }, // executor
			],
		});

		expect(recordAiUsage).toHaveBeenCalledTimes(2); // one row per distinct model
		// Advisor row: credits omitted (settled from cost), summed tokens, source threaded. The
		// reserved hold is reconciled IN PLACE on this first row (holdId).
		expect(recordAiUsage).toHaveBeenNthCalledWith(1, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			credits: undefined,
			source: "included",
			refId: "thread-1",
			holdId: "hold-1",
			model: SONNET,
			inputTokens: 100,
			outputTokens: 40,
			cachedInputTokens: 0,
		});
		// Executor row: ALSO omits credits (its own cost), summed tokens, and appends (no holdId).
		expect(recordAiUsage).toHaveBeenNthCalledWith(2, {
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			credits: undefined,
			source: "included",
			refId: "thread-1",
			holdId: undefined,
			model: HAIKU,
			inputTokens: 420,
			outputTokens: 110,
			cachedInputTokens: 0,
		});
		// Belt-and-braces: no row carries an explicit credit number (toEqual ignores undefined).
		for (const [arg] of vi.mocked(recordAiUsage).mock.calls) {
			expect(arg.credits).toBeUndefined();
		}
	});

	it("threads a purchased settle source onto each row", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "purchased", settle: true, holdId: "hold-2" },
			steps: [{ model: HAIKU, usage: { inputTokens: 10, outputTokens: 5 } }],
		});
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
		expect(recordAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ model: HAIKU, source: "purchased", holdId: "hold-2" }),
		);
		expect(vi.mocked(recordAiUsage).mock.calls[0][0].credits).toBeUndefined();
	});

	it("RELEASES the reserved hold on an empty turn (no steps) — one 0-cost reconcile call", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", settle: true, holdId: "hold-3" },
			refId: "thread-1",
			steps: [],
		});
		// The hold must be released (reconciled to 0) — a single call carrying only the holdId,
		// no model/credits, so recordAiUsage updates the row to 0 credits instead of leaking it.
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
		expect(recordAiUsage).toHaveBeenCalledWith({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			refId: "thread-1",
			holdId: "hold-3",
		});
	});

	it("no-ops on an empty turn with NO hold (fixed/legacy charge) — nothing to release", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", credits: 0 },
			steps: [],
		});
		expect(recordAiUsage).not.toHaveBeenCalled();
	});
});

describe("recordAgentTurnUsage — fixed (reservation) charge", () => {
	it("charges credits once (first model) and records the rest as cost-only rows", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", credits: 200 },
			refId: "thread-1",
			steps: [
				{ model: SONNET, usage: { inputTokens: 100, outputTokens: 40 } },
				{ model: HAIKU, usage: { inputTokens: 300, outputTokens: 80 } },
			],
		});
		expect(recordAiUsage).toHaveBeenCalledTimes(2);
		expect(recordAiUsage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ model: SONNET, credits: 200 }),
		);
		expect(recordAiUsage).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ model: HAIKU, credits: 0 }),
		);
	});
});
