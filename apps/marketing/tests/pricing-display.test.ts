// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the public pricing page's live Team price. Two boundaries: the
// Stripe client and Next's `unstable_cache` (unwrapped to the raw callback so each test sees
// a fresh read). The plan-catalog fallback and `formatSeatPrice` run for real.
//
// WHY THIS FILE EXISTS (#4096). The `usd` label in `getTeamPrice` is the LAST place in the
// repo that hands a live Stripe `Price.currency` to a formatter that divides by 100. Every console
// call site moved to `@repo/format`, which takes its divisor from Stripe's charge table;
// marketing cannot follow, because `@repo/format` exports raw TypeScript and is absent from
// `next.config.ts`'s `transpilePackages` — and it carries `date-fns`, so the edge would also
// destroy `@repo/plan-catalog`'s zero-runtime-dependency property. So this call site narrows
// the currency instead, and these tests are what makes the narrowing a contract rather than
// a comment: an unsupported code must reach the catalog label, never a 100x-wrong number.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();

vi.mock("next/cache", () => ({
	// Unwrap the cache: return the callback itself so every call really reads Stripe.
	unstable_cache: (cb: unknown) => cb,
}));

vi.mock("stripe", () => ({
	default: class {
		prices = { retrieve };
	},
}));

import { formatSeatPrice } from "@repo/plan-catalog";
import { getTeamPrice } from "../lib/billing/pricing-display";

/** The static catalog labels this module falls back to. */
const CATALOG_USD = "$20 / seat / mo";
const CATALOG_EUR = "€18 / seat / mo";

beforeEach(() => {
	vi.clearAllMocks();
	process.env.STRIPE_SECRET_KEY = "sk_test_marketing";
	process.env.STRIPE_PRICE_TEAM = "price_team";
});

afterEach(() => {
	delete process.env.STRIPE_SECRET_KEY;
	delete process.env.STRIPE_PRICE_TEAM;
});

describe("getTeamPrice — catalog fallback (the public page must never throw)", () => {
	it("uses the catalog when STRIPE_SECRET_KEY is unset", async () => {
		delete process.env.STRIPE_SECRET_KEY;
		const labels = await getTeamPrice();
		expect(retrieve).not.toHaveBeenCalled();
		expect(labels).toEqual({ usd: CATALOG_USD, eur: CATALOG_EUR });
	});

	it("uses the catalog when STRIPE_PRICE_TEAM is unset", async () => {
		delete process.env.STRIPE_PRICE_TEAM;
		const labels = await getTeamPrice();
		expect(retrieve).not.toHaveBeenCalled();
		expect(labels.usd).toBe(CATALOG_USD);
	});

	it("uses the catalog when the retrieve throws", async () => {
		retrieve.mockRejectedValue(new Error("stripe down"));
		const labels = await getTeamPrice();
		expect(labels).toEqual({ usd: CATALOG_USD, eur: CATALOG_EUR });
	});

	it("uses the catalog when the price carries no unit_amount", async () => {
		retrieve.mockResolvedValue({ unit_amount: null, currency: "usd" });
		const labels = await getTeamPrice();
		expect(labels.usd).toBe(CATALOG_USD);
	});
});

describe("getTeamPrice — live Stripe amounts", () => {
	it("renders both currencies from the live price and its EUR currency_option", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			recurring: { interval: "month" },
			currency_options: { eur: { unit_amount: 2300 } },
		});

		const labels = await getTeamPrice();
		expect(retrieve).toHaveBeenCalledWith("price_team", { expand: ["currency_options"] });
		// The COMPACT register — `$25`, not `$25.00`. This is why `@repo/plan-catalog` still
		// carries a money formatter of its own rather than deferring to `@repo/format`'s.
		expect(labels.usd).toBe("$25 / seat / mo");
		expect(labels.eur).toBe("€23 / seat / mo");
	});

	it("keeps the catalog EUR label when the price has no EUR currency_option", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 2500,
			currency: "usd",
			recurring: { interval: "month" },
			currency_options: {},
		});
		const labels = await getTeamPrice();
		expect(labels.usd).toBe("$25 / seat / mo");
		expect(labels.eur).toBe(CATALOG_EUR);
	});

	it("falls back rather than rendering a currency we do not sell in (#4096)", async () => {
		// The defect, at its last reachable site. `formatSeatPrice` divides by 100; JPY is quoted
		// in whole yen, so a ¥124,000 price used to render `JPY 1240 / seat / mo` on the public
		// pricing page — 100x under, and plausible enough that nothing would have caught it.
		// Narrowing the currency makes that unrepresentable, and the answer is the catalog label:
		// the slot is LABELLED `usd`, so a price quoted in something else does not belong in it
		// at any scale.
		retrieve.mockResolvedValue({
			unit_amount: 124000,
			currency: "jpy",
			recurring: { interval: "month" },
			currency_options: {},
		});

		const labels = await getTeamPrice();
		expect(labels.usd).toBe(CATALOG_USD);
		expect(labels.usd).not.toContain("1240");
	});

	it("abbreviates a yearly interval and keeps a fractional amount's cents", async () => {
		retrieve.mockResolvedValue({
			unit_amount: 24050,
			currency: "usd",
			recurring: { interval: "year" },
			currency_options: {},
		});
		const labels = await getTeamPrice();
		expect(labels.usd).toBe("$240.50 / seat / yr");
	});
});

describe("formatSeatPrice — the compile-time half of #4096's fix", () => {
	it("cannot be handed a currency we do not sell in", () => {
		// THE ASSERTION HERE IS `tsc`'s, NOT VITEST'S, and the closure is never invoked. The
		// `/ 100` inside `formatSeatPrice` is correct only because `currency` cannot be anything
		// but `usd` or `eur`; nothing at runtime can assert that a TYPE has not widened. `tsc`
		// reports an unused `@ts-expect-error` as TS2578, so the directive below turns RED — and
		// fails `pnpm -F marketing check-types` — the moment the parameter goes back to `string`.
		//
		// It lives in this file rather than beside the function because
		// `packages/plan-catalog/tsconfig.json` includes only `src`: that package's own suite is
		// transpiled and never type-checked, so the same directive there would sit green forever.
		// `apps/marketing`'s tsconfig includes `**/*.ts`.
		const call = () =>
			formatSeatPrice(
				124000,
				// @ts-expect-error — "jpy" is not a SupportedCurrency, and that is the assertion.
				"jpy",
				"month",
			);
		expect(typeof call).toBe("function");
	});
});
