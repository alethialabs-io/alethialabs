// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the ORG PLAN live pricing (lib/billing/pricing.ts): getPlanPrice /
// getAllPlanPrices. The sibling ai-pricing.test.ts covers the AI tiers. Until #5219 these ran only
// incidentally, when a component test rendered the buy flow and reached the real
// getLivePlanPrices action. That action now requires a signed-in caller, so they are pinned
// here directly. Boundaries: the Stripe client and the billing config. The plan catalog and the
// formatters run for real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
const isStripeConfigured = vi.fn();

vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({ prices: { retrieve } }),
}));
vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: () => isStripeConfigured(),
	aiPaidTiersEnabled: () => false,
	aiPriceIdForTier: (tier: string) => `price_${tier}`,
	priceIdForPlan: (plan: string) => `price_${plan}`,
}));

import { getAllPlanPrices, getPlanPrice } from "@/lib/billing/pricing";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getAllPlanPrices", () => {
	it("answers every plan from the catalog without touching Stripe when it is unconfigured", async () => {
		isStripeConfigured.mockReturnValue(false);
		const map = await getAllPlanPrices();
		expect(Object.keys(map).sort()).toEqual(["community", "enterprise", "team"]);
		expect(retrieve).not.toHaveBeenCalled();
		expect(map.team.currency).toBe("usd");
		expect(map.team.interval).toBe("month");
	});

	it("reads team and enterprise from Stripe (never community) once it is configured", async () => {
		isStripeConfigured.mockReturnValue(true);
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			currency_options: { eur: { unit_amount: 2300 } },
			recurring: { interval: "month" },
		});
		const map = await getAllPlanPrices();
		expect(retrieve).toHaveBeenCalledTimes(2);
		expect(retrieve).not.toHaveBeenCalledWith("price_community", expect.anything());
		expect(map.team.amounts.usd).toEqual({ minor: 2500, currency: "usd" });
		expect(map.team.amounts.eur).toEqual({ minor: 2300, currency: "eur" });
		expect(map.team.currency).toBe("usd");
	});

	it("falls back to the catalog when Stripe has no unit amount, an unsupported currency, or throws", async () => {
		isStripeConfigured.mockReturnValue(false);
		const catalog = await getPlanPrice("team");
		isStripeConfigured.mockReturnValue(true);

		for (const answer of [
			Promise.resolve({ unit_amount: null, currency: "usd" }),
			Promise.resolve({ unit_amount: 2500, currency: "jpy" }),
			Promise.reject(new Error("stripe down")),
		]) {
			answer.catch(() => {});
			retrieve.mockReturnValueOnce(answer).mockReturnValueOnce(answer);
			const map = await getAllPlanPrices();
			expect(map.team).toEqual(catalog);
		}
	});
});
