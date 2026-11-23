// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The turnover sums the purchase gate reads (#7324, `lib/billing/turnover.ts`). The threshold RULES
// are EA-1's (`packages/legal/src/thresholds.test.ts`); this file pins only what is summed, into
// which period, and that an unreadable figure fails closed.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	assessSaleAgainstTotals,
	CONSERVATIVE_CROSS_RATE,
	eurMinorOf,
	sumTurnover,
	type TurnoverRow,
	usdMinorOf,
} from "@/lib/billing/turnover";

const NOW = new Date("2027-03-15T12:00:00Z");

/** A paid row with the snapshot filled in; override what the case is about. */
function row(over: Partial<TurnoverRow>): TurnoverRow {
	return {
		customerCountry: "DE",
		customerState: null,
		payerCapacity: "organization",
		vatIdGiven: false,
		amountEurMinor: 2900,
		amountTotal: 2900,
		currency: "eur",
		paidAt: new Date("2027-02-01T00:00:00Z"),
		...over,
	};
}

describe("conversions overestimate, never under", () => {
	it("is exact in its own currency and multiplied by the conservative rate across", () => {
		expect(eurMinorOf({ amountMinor: 1000, currency: "EUR" })).toBe(1000);
		expect(eurMinorOf({ amountMinor: 1000, currency: "usd" })).toBe(1000 * CONSERVATIVE_CROSS_RATE);
		expect(usdMinorOf({ amountMinor: 1000, currency: "usd" })).toBe(1000);
		expect(usdMinorOf({ amountMinor: 1000, currency: "eur" })).toBe(1000 * CONSERVATIVE_CROSS_RATE);
	});

	it("cannot convert an unknown currency, and says so with NaN", () => {
		expect(eurMinorOf({ amountMinor: 1000, currency: "gbp" })).toBeNaN();
		expect(usdMinorOf({ amountMinor: 1000, currency: "gbp" })).toBeNaN();
	});
});

describe("sumTurnover", () => {
	it("counts an EU no-VAT-number sale toward the EU total AND the Bulgarian one", () => {
		const t = sumTurnover([row({})], NOW);
		expect(t.euCurrentYearEurMinor).toBe(2900);
		expect(t.bgCalendarYearEurMinor).toBe(2900);
	});

	it("does not count an EU business that gave a VAT number", () => {
		const t = sumTurnover([row({ vatIdGiven: true })], NOW);
		expect(t.euCurrentYearEurMinor).toBe(0);
		expect(t.bgCalendarYearEurMinor).toBe(0);
	});

	it("counts a Bulgarian sale toward the Bulgarian total only", () => {
		const t = sumTurnover([row({ customerCountry: "BG", vatIdGiven: true })], NOW);
		expect(t.bgCalendarYearEurMinor).toBe(2900);
		expect(t.euCurrentYearEurMinor).toBe(0);
	});

	it("puts last year's EU sales in the previous-year total, not this year's", () => {
		const t = sumTurnover([row({ paidAt: new Date("2026-06-01T00:00:00Z") })], NOW);
		expect(t.euPreviousYearEurMinor).toBe(2900);
		expect(t.euCurrentYearEurMinor).toBe(0);
		expect(t.bgCalendarYearEurMinor).toBe(0);
	});

	it("skips a row with no snapshot country — it predates the snapshot", () => {
		const t = sumTurnover([row({ customerCountry: null })], NOW);
		expect(t.euCurrentYearEurMinor).toBe(0);
	});

	it("falls back to a conservative conversion when the EUR amount was not recorded", () => {
		const t = sumTurnover([row({ amountEurMinor: null, amountTotal: 1000, currency: "usd" })], NOW);
		expect(t.euCurrentYearEurMinor).toBe(1000 * CONSERVATIVE_CROSS_RATE);
	});

	it("fails closed on an amount it cannot read", () => {
		const t = sumTurnover([row({ amountEurMinor: null, currency: "gbp" })], NOW);
		expect(t.euCurrentYearEurMinor).toBeNaN();
	});

	it("counts US revenue and transactions per state", () => {
		const t = sumTurnover(
			[
				row({ customerCountry: "US", customerState: "NY", amountTotal: 5000, currency: "usd" }),
				row({ customerCountry: "US", customerState: "NY", amountTotal: 5000, currency: "usd" }),
				row({ customerCountry: "US", customerState: "CA", amountTotal: 100, currency: "usd" }),
			],
			NOW,
		);
		expect(t.usStates.get("NY")).toEqual({ revenueUsdMinor: 10000, transactions: 2 });
		expect(t.usStates.get("CA")).toEqual({ revenueUsdMinor: 100, transactions: 1 });
	});

	it("poisons every state's total with a US sale that has no state", () => {
		const t = sumTurnover([row({ customerCountry: "US", customerState: null, currency: "usd" })], NOW);
		const assessed = assessSaleAgainstTotals(
			{ country: "US", capacity: "organization", vatIdGiven: null, state: "TX" },
			null,
			t,
		);
		expect(assessed[0]?.assessment.verdict).toBe("stop");
	});
});

describe("assessSaleAgainstTotals — stop BEFORE the sale that crosses", () => {
	const EU_NO_VAT = { country: "FR", capacity: "organization", vatIdGiven: false, state: null } as const;

	it("stops the sale that would take the EU total over EUR 10,000", () => {
		const totals = sumTurnover([row({ amountEurMinor: 9_990_00, amountTotal: 9_990_00 })], NOW);
		const assessed = assessSaleAgainstTotals(EU_NO_VAT, { amountMinor: 2900, currency: "eur" }, totals);
		const eu = assessed.find((a) => a.counter.id === "eu_cross_border_no_vat_id");
		expect(eu?.assessment.verdict).toBe("stop");
	});

	it("lets a sale through that stays under, with a warning near the line", () => {
		const totals = sumTurnover([row({ amountEurMinor: 8_500_00, amountTotal: 8_500_00 })], NOW);
		const assessed = assessSaleAgainstTotals(EU_NO_VAT, { amountMinor: 2900, currency: "eur" }, totals);
		const eu = assessed.find((a) => a.counter.id === "eu_cross_border_no_vat_id");
		expect(eu?.assessment.verdict).toBe("warn");
	});

	it("assesses nothing for a buyer outside BG, the EU and the US", () => {
		const totals = sumTurnover([], NOW);
		expect(
			assessSaleAgainstTotals(
				{ country: "GB", capacity: "organization", vatIdGiven: null, state: null },
				null,
				totals,
			),
		).toEqual([]);
	});
});
