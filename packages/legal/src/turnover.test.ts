// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	assessSaleAgainstTurnover,
	assessTurnover,
	bulgarianYear,
	type TurnoverFact,
	thresholdEscalations,
	turnoverTotals,
	turnoverWindowStart,
} from "./turnover";

const NOW = new Date("2027-06-15T12:00:00Z");

/** A paid EUR invoice to a BG organization; override any field. */
function fact(over: Partial<TurnoverFact> = {}): TurnoverFact {
	return {
		status: "paid",
		paidAt: new Date("2027-03-01T10:00:00Z"),
		currency: "eur",
		amountMinor: 100_00,
		amountEurMinor: 100_00,
		country: "BG",
		state: null,
		capacity: "organization",
		vatIdGiven: false,
		...over,
	};
}

describe("turnoverTotals — which invoices count where", () => {
	it("a BG sale counts toward Bulgaria only", () => {
		const t = turnoverTotals([fact()], NOW);
		expect(t.bg).toEqual({ eurMinor: 100_00, invoices: 1, unconverted: 0 });
		expect(t.euCurrent.invoices).toBe(0);
	});

	it("an EU sale with no VAT number counts toward the EU AND Bulgarian totals", () => {
		const t = turnoverTotals([fact({ country: "DE", vatIdGiven: false })], NOW);
		expect(t.euCurrent.eurMinor).toBe(100_00);
		expect(t.bg.eurMinor).toBe(100_00);
	});

	it("an EU organization that gave a VAT number counts toward nothing", () => {
		const t = turnoverTotals([fact({ country: "DE", vatIdGiven: true })], NOW);
		expect(t.euCurrent.invoices + t.bg.invoices).toBe(0);
	});

	it("the snapshot decides, not anything else: a consumer in FR counts toward the EU", () => {
		const t = turnoverTotals([fact({ country: "FR", capacity: "consumer", vatIdGiven: null })], NOW);
		expect(t.euCurrent.invoices).toBe(1);
	});

	it("voided and refunded invoices drop out of every total", () => {
		const t = turnoverTotals(
			[fact({ status: "void" }), fact({ status: "refunded" }), fact({ amountMinor: 5_00, amountEurMinor: 5_00 })],
			NOW,
		);
		expect(t.bg).toEqual({ eurMinor: 5_00, invoices: 1, unconverted: 0 });
	});

	it("last year's EU sales go to euPrevious; last year's BG sales count nowhere", () => {
		const t = turnoverTotals([fact({ country: "IT", paidAt: new Date("2026-08-01T00:00:00Z") })], NOW);
		expect(t.euPrevious.eurMinor).toBe(100_00);
		expect(t.euCurrent.invoices).toBe(0);
		expect(t.bg.invoices).toBe(0);
	});

	it("the calendar year is Bulgarian: 31 Dec 22:30 UTC is already next year in Sofia", () => {
		const newYear = new Date("2026-12-31T22:30:00Z");
		expect(bulgarianYear(newYear)).toBe(2027);
		const t = turnoverTotals([fact({ paidAt: newYear })], NOW);
		expect(t.bg.invoices).toBe(1);
	});

	it("a counted invoice with no EUR amount is unconverted, and a non-EUR one is not guessed", () => {
		const t = turnoverTotals([fact({ currency: "usd", amountEurMinor: null })], NOW);
		expect(t.bg).toEqual({ eurMinor: 0, invoices: 1, unconverted: 1 });
	});

	it("an EUR invoice with no recorded rate uses its own amount", () => {
		const t = turnoverTotals([fact({ amountEurMinor: null, amountMinor: 42_00 })], NOW);
		expect(t.bg).toEqual({ eurMinor: 42_00, invoices: 1, unconverted: 0 });
	});

	it("an unsnapshotted EUR invoice is counted toward the EU and BG totals; any other is unattributed", () => {
		const blank = { country: null, capacity: null, vatIdGiven: null, amountEurMinor: null };
		const t = turnoverTotals([fact(blank), fact({ ...blank, currency: "usd" })], NOW);
		expect(t.euCurrent.invoices).toBe(1);
		expect(t.bg.invoices).toBe(1);
		expect(t.unattributed.invoices).toBe(1);
	});

	it("rows after `now`, or with no payment date, are not counted", () => {
		const t = turnoverTotals(
			[fact({ paidAt: null }), fact({ paidAt: new Date("2027-07-01T00:00:00Z") })],
			NOW,
		);
		expect(t.bg.invoices).toBe(0);
	});

	it("turnoverWindowStart is before the previous Bulgarian year begins", () => {
		const start = turnoverWindowStart(NOW);
		expect(start.getTime()).toBeLessThan(new Date("2025-12-31T22:00:00Z").getTime());
	});
});

describe("turnoverTotals — US per state", () => {
	/** A paid USD invoice to a US organization in `state`. */
	const us = (state: string | null, paidAt: string, amountMinor = 10_00): TurnoverFact =>
		fact({
			country: "US",
			state,
			currency: "usd",
			amountMinor,
			amountEurMinor: null,
			paidAt: new Date(paidAt),
		});

	it("counts revenue AND transactions per state", () => {
		const t = turnoverTotals([us("ny", "2027-02-01T00:00:00Z"), us("NY", "2027-03-01T00:00:00Z")], NOW);
		expect(t.usStates).toEqual([
			{ state: "NY", revenueUsdMinor: 20_00, transactions: 2, unconverted: 0 },
		]);
	});

	it("takes the largest measuring period: last calendar year beats this year's few sales", () => {
		const facts = [
			us("GA", "2026-02-01T00:00:00Z"),
			us("GA", "2026-03-01T00:00:00Z"),
			us("GA", "2026-04-01T00:00:00Z"),
			us("GA", "2027-05-01T00:00:00Z"),
		];
		// Previous calendar year: 3. Trailing twelve months (from 2026-06-15): 1. Last four quarters
		// (2026-04-01 → 2027-04-01): 1.
		expect(turnoverTotals(facts, NOW).usStates[0]?.transactions).toBe(3);
	});

	it("a US sale with no usable state is counted toward no state, and reported", () => {
		const t = turnoverTotals([us(null, "2027-02-01T00:00:00Z")], NOW);
		expect(t.usStates).toEqual([]);
		expect(t.usNoState).toEqual({ invoices: 1, revenueUsdMinor: 10_00 });
	});

	it("a US sale not billed in USD makes that state's totals unconverted", () => {
		const t = turnoverTotals([fact({ country: "US", state: "TX", currency: "eur" })], NOW);
		expect(t.usStates[0]?.unconverted).toBe(1);
	});
});

describe("assessTurnover", () => {
	it("is ok on nothing, warns at 80%, stops above the BG threshold", () => {
		expect(assessTurnover(turnoverTotals([], NOW)).bg.verdict).toBe("ok");
		const warn = turnoverTotals([fact({ amountEurMinor: 41_000_00 })], NOW);
		expect(assessTurnover(warn).bg.verdict).toBe("warn");
		const over = turnoverTotals([fact({ amountEurMinor: 51_130_01 })], NOW);
		expect(assessTurnover(over).bg.verdict).toBe("stop");
	});

	it("an unconverted invoice makes the total unreadable, and unreadable is stop", () => {
		const t = turnoverTotals([fact({ currency: "usd", amountEurMinor: null })], NOW);
		expect(assessTurnover(t).bg).toEqual({ verdict: "stop", usage: Number.POSITIVE_INFINITY });
	});

	it("last year's EU crossing stops this year", () => {
		const t = turnoverTotals(
			[fact({ country: "AT", amountEurMinor: 10_000_01, paidAt: new Date("2026-05-01T00:00:00Z") })],
			NOW,
		);
		expect(assessTurnover(t).eu.verdict).toBe("stop");
	});

	it("sorts US states nearest threshold first", () => {
		const facts = Array.from({ length: 190 }, () =>
			fact({ country: "US", state: "GA", currency: "usd", amountMinor: 1_00 }),
		).concat([fact({ country: "US", state: "CA", currency: "usd", amountMinor: 1_00 })]);
		const states = assessTurnover(turnoverTotals(facts, NOW)).usStates.map((s) => s.state);
		expect(states).toEqual(["GA", "CA"]);
	});
});

describe("assessSaleAgainstTurnover — the gate acts BEFORE the crossing sale", () => {
	const nearEu = turnoverTotals([fact({ country: "DE", amountEurMinor: 9_950_00 })], NOW);

	it("refuses the EU sale that would cross EUR 10,000, while the totals alone read warn", () => {
		expect(assessTurnover(nearEu).eu.verdict).toBe("warn");
		const sale = assessSaleAgainstTurnover(nearEu, {
			country: "FR",
			capacity: "consumer",
			vatIdGiven: null,
			amountEurMinor: 51_00,
		});
		expect(sale.verdict).toBe("stop");
		expect(sale.counters.map((c) => c.counter.id)).toEqual(["eu_cross_border_no_vat_id", "bg_place_of_supply"]);
	});

	it("allows the sale that lands exactly on EUR 10,000 (the text is 'exceeds')", () => {
		const sale = assessSaleAgainstTurnover(nearEu, {
			country: "FR",
			capacity: "consumer",
			vatIdGiven: null,
			amountEurMinor: 50_00,
		});
		expect(sale.verdict).toBe("warn");
	});

	it("an EU VAT-number sale counts toward nothing and is ok", () => {
		const sale = assessSaleAgainstTurnover(nearEu, {
			country: "FR",
			capacity: "organization",
			vatIdGiven: true,
		});
		expect(sale).toEqual({ verdict: "ok", usage: 0, counters: [] });
	});

	it("a sale missing the amount its counter needs is stop", () => {
		const sale = assessSaleAgainstTurnover(turnoverTotals([], NOW), {
			country: "BG",
			capacity: "consumer",
			vatIdGiven: null,
		});
		expect(sale.verdict).toBe("stop");
	});

	it("the 200th US transaction in Georgia is refused before it is taken", () => {
		const facts = Array.from({ length: 199 }, () =>
			fact({ country: "US", state: "GA", currency: "usd", amountMinor: 1_00 }),
		);
		const sale = assessSaleAgainstTurnover(turnoverTotals(facts, NOW), {
			country: "US",
			capacity: "organization",
			vatIdGiven: null,
			state: "GA",
			amountUsdMinor: 1_00,
		});
		expect(sale.verdict).toBe("stop");
	});

	it("a first sale into a state with no history is assessed from zero", () => {
		const sale = assessSaleAgainstTurnover(turnoverTotals([], NOW), {
			country: "US",
			capacity: "organization",
			vatIdGiven: null,
			state: "NY",
			amountUsdMinor: 10_00,
		});
		expect(sale.verdict).toBe("ok");
	});

	it("the page and the gate agree: the gate's 'no sale' reading is the page's", () => {
		const t = turnoverTotals([fact({ amountEurMinor: 45_000_00 })], NOW);
		const gate = assessSaleAgainstTurnover(t, {
			country: "BG",
			capacity: "organization",
			vatIdGiven: false,
			amountEurMinor: 0,
		});
		expect(gate.counters[0]?.assessment).toEqual(assessTurnover(t).bg);
	});
});

describe("thresholdEscalations — one alert per rise", () => {
	it("fires when a total reaches the warning margin, and again when it reaches the threshold", () => {
		const a = assessTurnover(turnoverTotals([fact({ amountEurMinor: 40_000_00 })], NOW));
		const b = assessTurnover(turnoverTotals([fact({ amountEurMinor: 41_000_00 })], NOW));
		const c = assessTurnover(turnoverTotals([fact({ amountEurMinor: 52_000_00 })], NOW));
		expect(thresholdEscalations(a, b)).toEqual([
			expect.objectContaining({ key: "bg:2027", from: "ok", to: "warn" }),
		]);
		expect(thresholdEscalations(b, c)).toEqual([
			expect.objectContaining({ key: "bg:2027", from: "warn", to: "stop" }),
		]);
	});

	it("does not fire again while the total stays in the same band", () => {
		const b = assessTurnover(turnoverTotals([fact({ amountEurMinor: 41_000_00 })], NOW));
		const b2 = assessTurnover(turnoverTotals([fact({ amountEurMinor: 42_000_00 })], NOW));
		expect(thresholdEscalations(b, b2)).toEqual([]);
	});

	it("a state seen for the first time already near its threshold fires", () => {
		const before = assessTurnover(turnoverTotals([], NOW));
		const after = assessTurnover(
			turnoverTotals([fact({ country: "US", state: "TX", currency: "usd", amountMinor: 450_000_00 })], NOW),
		);
		expect(thresholdEscalations(before, after)).toEqual([
			expect.objectContaining({ key: "us:TX", to: "warn" }),
		]);
	});
});
