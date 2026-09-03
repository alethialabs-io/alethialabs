// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the ORG-PLAN live pricing (lib/billing/pricing.ts):
// getPlanPrice / getAllPlanPrices. The sibling of ai-pricing.test.ts, which covers the
// standalone AI tiers in the same module; the boundaries and the mocks are identical
// (the Stripe client and the billing config flags) and the plan-catalog fallback plus the
// shared @repo/format formatters run for real.
//
// WHY THIS FILE EXISTS (#4096). getPlanPrice returned each Stripe amount TWICE — once as a
// `label` string, once as a `unitAmount*` number — and both paths divided the same
// `price.unit_amount` by a hardcoded 100. That is two INDEPENDENT unconditional divisions,
// not a compounded one: nothing was ever divided by 10,000, and deleting either of them to
// "fix a double division" would simply have broken the path it belonged to. The divisor now
// comes from Stripe's own charge table (packages/format/src/minor-units.ts), so the JPY
// case below is the assertion that matters and it pins BOTH paths at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
const isStripeConfigured = vi.fn();

vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({ prices: { retrieve } }),
}));
vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: () => isStripeConfigured(),
	priceIdForPlan: (plan: string) => `price_${plan}`,
	// The AI half of pricing.ts imports these; unused by these tests.
	aiPaidTiersEnabled: () => false,
	aiPriceIdForTier: (tier: string) => `price_${tier}`,
}));

import { getAllPlanPrices, getPlanPrice } from "@/lib/billing/pricing";

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("getPlanPrice — catalog fallback (degrades cleanly)", () => {
	it("treats community as free without a Stripe lookup, even when configured", async () => {
		isStripeConfigured.mockReturnValue(true);
		const community = await getPlanPrice("community");
		expect(retrieve).not.toHaveBeenCalled();
		expect(community.unitAmountUsd).toBe(0);
		expect(community.label).toBe("Free");
	});

	it("returns the catalog price without touching Stripe when unconfigured", async () => {
		isStripeConfigured.mockReturnValue(false);
		const team = await getPlanPrice("team");
		expect(retrieve).not.toHaveBeenCalled();
		expect(team.unitAmountUsd).toBe(20);
		expect(team.unitAmountEur).toBe(18);
		// The catalog's own static copy, not a formatted amount — marketing writes this string.
		expect(team.label).toBe("$20 / seat / mo");
	});

	it("falls back when the Stripe lookup throws (never throws itself)", async () => {
		isStripeConfigured.mockReturnValue(true);
		retrieve.mockRejectedValue(new Error("stripe down"));
		const team = await getPlanPrice("team");
		expect(team.unitAmountUsd).toBe(20);
		expect(team.label).toBe("$20 / seat / mo");
	});

	it("falls back when the price carries no unit_amount (a tiered price)", async () => {
		isStripeConfigured.mockReturnValue(true);
		retrieve.mockResolvedValue({ unit_amount: null, currency: "usd" });
		const team = await getPlanPrice("team");
		expect(team.unitAmountUsd).toBe(20);
		expect(team.label).toBe("$20 / seat / mo");
	});
});

describe("getPlanPrice — live Stripe amount", () => {
	beforeEach(() => {
		isStripeConfigured.mockReturnValue(true);
	});

	it("reads the authoritative unit amount + EUR option and labels it per-seat", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			recurring: { interval: "month" },
			currency_options: { eur: { unit_amount: 2300 } },
		});

		const team = await getPlanPrice("team");
		expect(retrieve).toHaveBeenCalledWith("price_team", { expand: ["currency_options"] });
		expect(team.unitAmountUsd).toBe(25);
		expect(team.unitAmountEur).toBe(23);
		// `$25.00`, not `$25`: the console renders money through @repo/format everywhere now.
		expect(team.label).toBe("$25.00 / seat / mo");
	});

	it("keeps the catalog EUR figure when the price has no EUR currency_option", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			recurring: { interval: "month" },
			currency_options: {},
		});
		const team = await getPlanPrice("team");
		expect(team.unitAmountEur).toBe(18);
	});

	it("drops '/ seat' for a plan that is not per-seat", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 250000,
			currency: "usd",
			recurring: { interval: "year" },
			currency_options: {},
		});
		const enterprise = await getPlanPrice("enterprise");
		expect(enterprise.label).toBe("$2,500.00 / yr");
		// Enterprise has no catalog price, so the EUR figure stays null rather than 0.
		expect(enterprise.unitAmountEur).toBeNull();
	});

	it("does not divide a zero-decimal currency — the divisor is Stripe's, not 100 (#4096)", async () => {
		// ¥124,000 is #3581's own example. Before this fix the SAME undivided amount produced a
		// label of `JPY 1240` and a number of 1240, from two separate `/ 100`s; the label is checked
		// here beside the number precisely because a lane reading the issue literally would expect
		// one of them to be 100x further out than the other, and neither ever was.
		retrieve.mockResolvedValue({
			unit_amount: 124000,
			currency: "jpy",
			recurring: { interval: "month" },
			currency_options: {},
		});

		const team = await getPlanPrice("team");
		expect(team.unitAmountUsd).toBe(124000);
		expect(team.label).toBe("¥124,000 / seat / mo");
		expect(team.currency).toBe("jpy");
	});

	it("divides a EUR currency_option by EUR's divisor, not the price's", async () => {
		// A `currency_options.eur` amount is quoted in EUR whatever the price's own currency is,
		// so the two fields in one object legitimately take two different divisors.
		retrieve.mockResolvedValue({
			unit_amount: 124000,
			currency: "jpy",
			recurring: { interval: "month" },
			currency_options: { eur: { unit_amount: 1800 } },
		});
		const team = await getPlanPrice("team");
		expect(team.unitAmountUsd).toBe(124000);
		expect(team.unitAmountEur).toBe(18);
	});
});

describe("getAllPlanPrices", () => {
	it("resolves the full community/team/enterprise map", async () => {
		isStripeConfigured.mockReturnValue(false);
		const map = await getAllPlanPrices();
		expect(map.community.label).toBe("Free");
		expect(map.team.unitAmountUsd).toBe(20);
		expect(map.enterprise.label).toBe("Let's talk");
	});
});
