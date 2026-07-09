// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// recordAiUsage settle path (lib/billing/ai-quota.ts): with `credits` OMITTED and a model
// present, the booked credits are DERIVED from the row's real cost-of-serve —
// costToCredits(cost_micros) = ceil(cost_micros / 1000). Mocks the DB insert + cost snapshot;
// the derivation (costToCredits) and cost math run for real via the ai-credits import.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const valuesSpy = vi.fn().mockResolvedValue(undefined);
const insertSpy = vi.fn(() => ({ values: valuesSpy }));
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({ insert: insertSpy }) }));
vi.mock("@/lib/db/schema", () => ({ aiUsageLedger: {}, aiCreditGrant: {} }));
vi.mock("@/lib/billing/model-costs", () => ({ aiCostMicros: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ captureAiGeneration: vi.fn() }));
vi.mock("@/lib/billing/ai-spend-alert", () => ({
	checkAiSpendThreshold: vi.fn(() => Promise.resolve()),
}));

import { recordAiUsage } from "@/lib/billing/ai-quota";
import { aiCostMicros } from "@/lib/billing/model-costs";

const MODEL = "anthropic/claude-sonnet-4-6";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("recordAiUsage settle (credits omitted)", () => {
	it("derives cost-weighted credits from cost_micros: ceil(cost_micros / 1000)", async () => {
		vi.mocked(aiCostMicros).mockReturnValue(84_000); // ≈$0.084
		await recordAiUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			model: MODEL,
			inputTokens: 1000,
			outputTokens: 500,
		});
		expect(valuesSpy).toHaveBeenCalledTimes(1);
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ credits: 84, cost_micros: 84_000, source: "included" }),
		);
	});

	it("rounds a fractional-unit cost UP (never undercharges)", async () => {
		vi.mocked(aiCostMicros).mockReturnValue(117_500); // ≈$0.1175 → 118 credits
		await recordAiUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "purchased",
			model: MODEL,
		});
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ credits: 118, source: "purchased" }),
		);
	});

	it("books an explicit credits figure verbatim (the FIXED path)", async () => {
		await recordAiUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "scan",
			credits: 200,
			source: "included",
		});
		// No model → no cost snapshot; the reserved credits are booked as-is.
		expect(aiCostMicros).not.toHaveBeenCalled();
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ credits: 200, cost_micros: null }),
		);
	});

	it("no-ops when there is nothing to record (0 credits, no model)", async () => {
		await recordAiUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
		});
		expect(insertSpy).not.toHaveBeenCalled();
	});
});
