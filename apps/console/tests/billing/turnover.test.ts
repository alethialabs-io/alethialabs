// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The purchase gate's threshold question (#7324, `lib/billing/turnover.ts`). Since #7352 the gate
// does no summing of its own: it asks EA-5's `assessSaleBeforeCharge`, which sums with
// `@repo/legal/turnover` — the admin page's function. The summing rules are
// `packages/legal/src/turnover.test.ts`'s subject; this file pins that the GATE gets the same answer,
// over an in-memory invoice store, and that it fails closed.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import type { InvoiceFactRow, TurnoverFactsReader } from "@/lib/billing/turnover-facts";
import {
	CONSERVATIVE_CROSS_RATE,
	crossedThresholds,
	eurMinorOf,
	type ThresholdBuyer,
	usdMinorOf,
} from "@/lib/billing/turnover";

const NOW = new Date("2027-06-15T12:00:00Z");

/** A paid EUR invoice to a German consumer this year; override what the case is about. */
function fact(over: Partial<InvoiceFactRow> = {}): InvoiceFactRow {
	return {
		id: "inv_1",
		eurRateSource: "EUR",
		status: "paid",
		paidAt: new Date("2027-03-01T10:00:00Z"),
		currency: "eur",
		amountMinor: 100_00,
		amountEurMinor: 100_00,
		country: "DE",
		state: null,
		capacity: "consumer",
		vatIdGiven: null,
		...over,
	};
}

/** A read that returns `rows` paid at or after `since`. */
function storeOf(rows: readonly InvoiceFactRow[]): TurnoverFactsReader {
	return { factsSince: async (since) => rows.filter((r) => r.paidAt !== null && r.paidAt >= since) };
}

/** A read that fails, as a database outage would. */
const brokenStore: TurnoverFactsReader = {
	factsSince: async () => {
		throw new Error("db down");
	},
};

const EU_CONSUMER: ThresholdBuyer = { country: "FR", capacity: "consumer", vatIdGiven: null, state: null };
const eur = (amountMinor: number) => ({ amountMinor, currency: "eur" });

describe("conversions of the sale being priced overestimate, never under", () => {
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

describe("crossedThresholds — the gate stops BEFORE the sale that crosses EUR 10,000", () => {
	const near = storeOf([fact({ amountMinor: 9_950_00, amountEurMinor: 9_950_00 })]);

	it("EUR 9,950 + EUR 51 → stop", async () => {
		const crossed = await crossedThresholds(EU_CONSUMER, eur(51_00), { now: NOW, store: near });
		expect(crossed.map((c) => c.counter.id)).toContain("eu_cross_border_no_vat_id");
	});

	it("EUR 9,950 + EUR 50 → allowed (the threshold is 'exceeds', so landing on it is not crossing)", async () => {
		expect(await crossedThresholds(EU_CONSUMER, eur(50_00), { now: NOW, store: near })).toEqual([]);
	});

	it("an unknown sale amount reads the totals alone, which still stops once a total is crossed", async () => {
		const over = storeOf([fact({ amountMinor: 10_000_01, amountEurMinor: 10_000_01 })]);
		expect(await crossedThresholds(EU_CONSUMER, null, { now: NOW, store: near })).toEqual([]);
		const crossed = await crossedThresholds(EU_CONSUMER, null, { now: NOW, store: over });
		expect(crossed.map((c) => c.counter.id)).toContain("eu_cross_border_no_vat_id");
	});

	it("does not count a voided or refunded invoice (EA-5's rule, not a second one)", async () => {
		const store = storeOf([fact({ status: "refunded", amountMinor: 9_990_00, amountEurMinor: 9_990_00 })]);
		expect(await crossedThresholds(EU_CONSUMER, eur(51_00), { now: NOW, store })).toEqual([]);
	});
});

describe("crossedThresholds — fail-closed", () => {
	it("an invoice whose EUR amount was never recorded makes the total unreadable → stop", async () => {
		const store = storeOf([fact({ currency: "usd", amountMinor: 1_00, amountEurMinor: null })]);
		const crossed = await crossedThresholds(EU_CONSUMER, eur(1_00), { now: NOW, store });
		expect(crossed.map((c) => c.counter.id)).toContain("eu_cross_border_no_vat_id");
	});

	it("a sale in a currency no threshold is kept in → stop", async () => {
		const crossed = await crossedThresholds(
			EU_CONSUMER,
			{ amountMinor: 1_00, currency: "gbp" },
			{ now: NOW, store: storeOf([]) },
		);
		expect(crossed.length).toBeGreaterThan(0);
	});

	it("a failed read throws, which the gate's caller treats as a refusal", async () => {
		await expect(
			crossedThresholds(EU_CONSUMER, eur(1_00), { now: NOW, store: brokenStore }),
		).rejects.toThrow("db down");
	});
});

describe("crossedThresholds — buyers who count toward nothing", () => {
	it("reads nothing for a buyer outside BG, the EU and the US", async () => {
		const buyer: ThresholdBuyer = { country: "GB", capacity: "organization", vatIdGiven: null, state: null };
		expect(await crossedThresholds(buyer, eur(1_00), { now: NOW, store: brokenStore })).toEqual([]);
	});

	it("a US sale is assessed against its state in USD", async () => {
		const store = storeOf(
			Array.from({ length: 199 }, (_, i) =>
				fact({ id: `inv_${i}`, country: "US", state: "GA", capacity: "organization", currency: "usd", amountMinor: 1_00 }),
			),
		);
		const buyer: ThresholdBuyer = { country: "US", capacity: "organization", vatIdGiven: null, state: "GA" };
		const crossed = await crossedThresholds(buyer, { amountMinor: 1_00, currency: "usd" }, { now: NOW, store });
		expect(crossed.map((c) => c.counter.id)).toEqual(["us_state"]);
	});
});
