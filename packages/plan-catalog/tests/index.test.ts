// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan catalog lives in @repo/plan-catalog (no test runner of its own); exercise it
// from the console suite, the same way @repo/ui/range is tested here.

import { describe, expect, it } from "vitest";
import {
	AI_PLAN_CATALOG,
	aiPlanMeta,
	aiPlanUnitAmountCents,
	asSupportedCurrency,
	formatSeatPrice,
	PAID_AI_PLANS,
	PAID_PLANS,
	PLAN_CATALOG,
	planMeta,
	planUnitAmountCents,
	shortInterval,
} from "../src/index";

describe("planMeta", () => {
	it("resolves each known plan to its display entry", () => {
		expect(planMeta("community").name).toBe("Hobby");
		expect(planMeta("team").name).toBe("Pro");
		expect(planMeta("enterprise").name).toBe("Enterprise");
	});

	it("falls back to community for an unknown id", () => {
		// @ts-expect-error — exercising the runtime fallback path
		expect(planMeta("mystery").id).toBe("community");
	});
});

describe("PLAN_CATALOG invariants", () => {
	it("has unique plan ids", () => {
		const ids = PLAN_CATALOG.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("marks Pro as per-seat with an included usage credit", () => {
		const team = planMeta("team");
		expect(team.perSeat).toBe(true);
		expect(team.priceMonthlyUsd).toBeGreaterThan(0);
		expect(team.includedCreditUsd).toBeGreaterThan(0);
	});

	it("prices Pro in both USD and EUR", () => {
		const team = planMeta("team");
		expect(team.priceMonthlyEur).toBeGreaterThan(0);
		// EUR is FX-adjusted, not parity.
		expect(team.priceMonthlyEur).not.toBe(team.priceMonthlyUsd);
	});
});

describe("planUnitAmountCents", () => {
	it("returns the per-currency amount in cents (default USD)", () => {
		expect(planUnitAmountCents("team")).toBe((planMeta("team").priceMonthlyUsd ?? 0) * 100);
		expect(planUnitAmountCents("team", "usd")).toBe(planUnitAmountCents("team"));
		expect(planUnitAmountCents("team", "eur")).toBe((planMeta("team").priceMonthlyEur ?? 0) * 100);
	});

	it("throws for a plan without a numeric price (Enterprise)", () => {
		expect(() => planUnitAmountCents("enterprise")).toThrow();
		expect(() => planUnitAmountCents("enterprise", "eur")).toThrow();
	});

	it("treats community as the only free tier", () => {
		expect(planMeta("community").paid).toBe(false);
		expect(PLAN_CATALOG.filter((p) => !p.paid)).toHaveLength(1);
	});
});

describe("PAID_PLANS", () => {
	it("is exactly the paid tiers (excludes community)", () => {
		expect(PAID_PLANS.every((p) => p.paid)).toBe(true);
		expect(PAID_PLANS.map((p) => p.id)).not.toContain("community");
	});
});

describe("AI plan catalog (final pricing)", () => {
	it("prices AI Plus at $20 / mo (€18)", () => {
		const plus = aiPlanMeta("ai_plus");
		expect(plus.priceLabel).toBe("$20 / mo");
		expect(plus.priceMonthlyUsd).toBe(20);
		expect(plus.priceMonthlyEur).toBe(18);
	});

	it("prices AI Max at $100 / mo (€90)", () => {
		const max = aiPlanMeta("ai_max");
		expect(max.priceLabel).toBe("$100 / mo");
		expect(max.priceMonthlyUsd).toBe(100);
		expect(max.priceMonthlyEur).toBe(90);
	});

	it("keeps AI Free free", () => {
		const free = aiPlanMeta("ai_free");
		expect(free.paid).toBe(false);
		expect(free.priceMonthlyUsd).toBe(0);
	});

	it("never leaks model names into user-facing copy", () => {
		// Tiers are described by what Elench does, not by which model serves it.
		for (const entry of AI_PLAN_CATALOG) {
			const strings = [entry.name, entry.tagline, entry.advisor, ...entry.highlights];
			for (const s of strings) {
				expect(s).not.toMatch(/sonnet|opus|haiku|executor/i);
			}
		}
	});

	it("recommends exactly one paid tier (AI Plus) to the upgrade UI", () => {
		const recommended = AI_PLAN_CATALOG.filter((p) => p.recommended);
		expect(recommended.map((p) => p.id)).toEqual(["ai_plus"]);
	});

	it("PAID_AI_PLANS excludes the free tier (the upgrade chooser never shows it)", () => {
		expect(PAID_AI_PLANS.every((p) => p.paid)).toBe(true);
		expect(PAID_AI_PLANS.map((p) => p.id)).toEqual(["ai_plus", "ai_max"]);
	});
});

describe("aiPlanUnitAmountCents (Stripe-provisioning SSOT)", () => {
	it("returns the final per-currency AI amounts in cents", () => {
		expect(aiPlanUnitAmountCents("ai_plus")).toBe(2000);
		expect(aiPlanUnitAmountCents("ai_plus", "eur")).toBe(1800);
		expect(aiPlanUnitAmountCents("ai_max")).toBe(10000);
		expect(aiPlanUnitAmountCents("ai_max", "eur")).toBe(9000);
	});

	it("is free (0 cents) for AI Free rather than throwing", () => {
		expect(aiPlanUnitAmountCents("ai_free")).toBe(0);
	});
});

// ── #4096: the live-price formatters ────────────────────────────────────────────
// `formatSeatPrice` divides a Stripe amount by 100. That was a latent defect while its
// `currency` was a bare `string` taken off a live `Price` — a zero-decimal currency would
// have rendered at 1/100 of its value. It is now correct BY CONSTRUCTION rather than by
// luck: the parameter is `SupportedCurrency`, and Stripe's charge table
// (`packages/format/src/minor-units.ts`) answers 100 for both of its members. These tests
// pin the compact register — the reason this formatter survives beside `@repo/format`'s —
// and the type that makes the divisor total.

describe("asSupportedCurrency", () => {
	it("narrows the currencies we sell in, in either spelling", () => {
		expect(asSupportedCurrency("usd")).toBe("usd");
		expect(asSupportedCurrency("EUR")).toBe("eur");
		expect(asSupportedCurrency(" Usd ")).toBe("usd");
	});

	it("refuses everything else rather than defaulting to USD", () => {
		// A zero-decimal Stripe currency is exactly what #4096 is about, and it must not narrow.
		expect(asSupportedCurrency("jpy")).toBeNull();
		expect(asSupportedCurrency("ugx")).toBeNull();
		// GBP has the right number of decimals and is still not a currency we sell in — the
		// symbol table used to carry a `gbp` row that nothing could ever reach.
		expect(asSupportedCurrency("gbp")).toBeNull();
		expect(asSupportedCurrency("")).toBeNull();
		expect(asSupportedCurrency(null)).toBeNull();
		expect(asSupportedCurrency(undefined)).toBeNull();
	});
});

describe("formatSeatPrice", () => {
	it("renders the compact register — a whole amount drops its minor units", () => {
		expect(formatSeatPrice(2000, "usd", "month")).toBe("$20 / seat / mo");
		expect(formatSeatPrice(1800, "eur", "year")).toBe("€18 / seat / yr");
	});

	it("keeps two decimals when the amount has them", () => {
		expect(formatSeatPrice(2050, "usd", "month")).toBe("$20.50 / seat / mo");
		expect(formatSeatPrice(1, "eur", "month")).toBe("€0.01 / seat / mo");
	});

	it("treats a missing interval as monthly and passes an unknown one through", () => {
		expect(formatSeatPrice(2000, "usd", null)).toBe("$20 / seat / mo");
		expect(formatSeatPrice(2000, "usd", undefined)).toBe("$20 / seat / mo");
		expect(formatSeatPrice(2000, "usd", "week")).toBe("$20 / seat / week");
	});

	// NO RUNTIME TEST FOR THE ZERO-DECIMAL CASE, and the omission is deliberate rather than a
	// gap: `currency` is `SupportedCurrency`, so "jpy" is not an input this function HAS. The
	// assertion that the union has not silently widened back to `string` is a COMPILE-time one
	// and it cannot live in this file — `packages/plan-catalog/tsconfig.json` includes only
	// `src`, so this suite is transpiled and never type-checked, and a `@ts-expect-error` here
	// would sit green whatever the signature said. It lives in
	// `apps/marketing/tests/pricing-display.test.ts`, whose tsconfig does include its tests.
});

describe("shortInterval", () => {
	it("abbreviates the two Stripe intervals, defaults to monthly, passes the rest through", () => {
		expect(shortInterval("month")).toBe("mo");
		expect(shortInterval("year")).toBe("yr");
		expect(shortInterval("week")).toBe("week");
		expect(shortInterval(null)).toBe("mo");
		expect(shortInterval(undefined)).toBe("mo");
	});
});
