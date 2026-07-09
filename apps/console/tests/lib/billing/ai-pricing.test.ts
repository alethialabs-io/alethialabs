// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the STANDALONE AI live pricing (lib/billing/pricing.ts):
// getAiPlanPrice / getAllAiPrices. The only boundaries are the Stripe client and the
// billing config feature flags; the plan-catalog fallback + shared formatters run for real.
// We assert: (1) it degrades to the placeholder AI catalog price pre-cutover (Stripe
// unconfigured OR the AI prices unset) without ever calling Stripe or throwing, (2) it
// reads the live Stripe amount once both AI prices are configured, and (3) a Stripe lookup
// failure falls back to the catalog rather than throwing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
const isStripeConfigured = vi.fn();
const aiPaidTiersEnabled = vi.fn();

vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({ prices: { retrieve } }),
}));
vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: () => isStripeConfigured(),
	aiPaidTiersEnabled: () => aiPaidTiersEnabled(),
	aiPriceIdForTier: (tier: string) => (tier === "ai_plus" ? "price_ai_plus" : "price_ai_max"),
	// priceIdForPlan is imported by pricing.ts (org plans) but unused by these tests.
	priceIdForPlan: (plan: string) => `price_${plan}`,
}));

import { getAiPlanPrice, getAllAiPrices } from "@/lib/billing/pricing";

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("getAiPlanPrice — pre-cutover fallback (degrades cleanly)", () => {
	it("returns the placeholder catalog price without touching Stripe when unconfigured", async () => {
		isStripeConfigured.mockReturnValue(false);
		aiPaidTiersEnabled.mockReturnValue(false);

		const plus = await getAiPlanPrice("ai_plus");
		expect(retrieve).not.toHaveBeenCalled();
		// Catalog placeholder for AI Plus ($20 / mo, €18).
		expect(plus.unitAmountUsd).toBe(20);
		expect(plus.unitAmountEur).toBe(18);
		expect(plus.label).toBe("$20 / mo");
	});

	it("falls back when Stripe is configured but the AI prices aren't set yet", async () => {
		isStripeConfigured.mockReturnValue(true);
		aiPaidTiersEnabled.mockReturnValue(false);

		const max = await getAiPlanPrice("ai_max");
		expect(retrieve).not.toHaveBeenCalled();
		expect(max.unitAmountUsd).toBe(100);
		expect(max.label).toBe("$100 / mo");
	});

	it("treats ai_free as free without a Stripe lookup even when configured", async () => {
		isStripeConfigured.mockReturnValue(true);
		aiPaidTiersEnabled.mockReturnValue(true);

		const free = await getAiPlanPrice("ai_free");
		expect(retrieve).not.toHaveBeenCalled();
		expect(free.unitAmountUsd).toBe(0);
		expect(free.label).toBe("Free");
	});
});

describe("getAiPlanPrice — live Stripe amount (post-cutover)", () => {
	beforeEach(() => {
		isStripeConfigured.mockReturnValue(true);
		aiPaidTiersEnabled.mockReturnValue(true);
	});

	it("reads the authoritative unit amount + EUR option from Stripe", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			recurring: { interval: "month" },
			currency_options: { eur: { unit_amount: 2300 } },
		});

		const plus = await getAiPlanPrice("ai_plus");
		expect(retrieve).toHaveBeenCalledWith("price_ai_plus", {
			expand: ["currency_options"],
		});
		// Live amount overrides the catalog placeholder.
		expect(plus.unitAmountUsd).toBe(25);
		expect(plus.unitAmountEur).toBe(23);
		expect(plus.label).toBe("$25 / mo");
	});

	it("falls back to the catalog when the Stripe lookup throws (never throws itself)", async () => {
		retrieve.mockRejectedValue(new Error("stripe down"));
		const max = await getAiPlanPrice("ai_max");
		expect(max.unitAmountUsd).toBe(100); // catalog placeholder
		expect(max.label).toBe("$100 / mo");
	});
});

describe("getAllAiPrices", () => {
	it("resolves the full free/plus/max map", async () => {
		isStripeConfigured.mockReturnValue(false);
		aiPaidTiersEnabled.mockReturnValue(false);

		const map = await getAllAiPrices();
		expect(Object.keys(map).sort()).toEqual(["ai_free", "ai_max", "ai_plus"]);
		expect(map.ai_free.label).toBe("Free");
		expect(map.ai_plus.unitAmountUsd).toBe(20);
		expect(map.ai_max.unitAmountUsd).toBe(100);
	});
});
