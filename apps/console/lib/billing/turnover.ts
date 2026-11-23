// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The running turnover totals the purchase gate reads before a sale (#7324, EA-2), and the ONE place
// the console turns invoice rows into those totals. The rules for reading a total against a threshold
// are `@repo/legal/thresholds` (EA-1); this file only sums.
//
// WHAT IS SUMMED. `invoice` rows with status `paid`, using the payer facts SNAPSHOTTED on each row at
// payment (`customer_country`, `customer_state`, `payer_capacity`, `vat_id_given`, `amount_eur_minor`,
// written by EA-5's invoice snapshot, #7327). Which counters a row adds to is decided by
// `thresholdCountersForSale` — the same function the gate asks about the NEXT sale — so the gate and
// the admin turnover page cannot count different sales. A row with no `customer_country` predates the
// snapshot and cannot be attributed to any counter, so it is not counted: before #7321 nothing was
// sold, and those rows are test-mode or staff artefacts.
//
// FAIL-CLOSED. A counted row whose amount cannot be read in the threshold's currency makes that total
// `NaN`, and `assessThreshold` reads `NaN` as `stop`. A broken counter must never read as room to sell.
//
// CURRENCY. The EU and Bulgarian thresholds are in EUR, the US ones in USD. A row carries its EUR
// amount (EA-5 converts with a recorded rate); a USD figure for a row billed in EUR, and the EUR figure
// of a sale not yet taken, are converted with `CONSERVATIVE_CROSS_RATE` — a deliberate OVERESTIMATE,
// because counting too much stops a sale early and counting too little lets one cross.
//
// REFUNDS. A refunded invoice moves to status `refunded` and leaves the sum; partial refunds are EA-5's
// (#7327) to net out on the row.

import { and, eq, gte } from "drizzle-orm";
import type { PayerCapacity } from "@repo/legal/commerce";
import {
	bgThresholdAssessment,
	euCrossBorderThresholdAssessment,
	type ThresholdAssessment,
	type ThresholdCounter,
	thresholdCountersForSale,
	usStateThresholdAssessment,
} from "@repo/legal/thresholds";
import { getServiceDb } from "@/lib/db";
import { invoice } from "@/lib/db/schema";

/**
 * The factor a USD amount is multiplied by to get an EUR figure, and an EUR amount to get a USD one,
 * when no recorded rate exists. 1.6 is above every EUR/USD and USD/EUR rate since the euro was
 * introduced (the pair has traded between about 0.82 and 1.60), so a converted figure is never below
 * the true one. Used only for the sale being priced and for rows EA-5 has not converted.
 */
export const CONSERVATIVE_CROSS_RATE = 1.6;

/** An amount in minor units of a currency (Stripe's lower-case ISO code). */
export interface SaleAmount {
	readonly amountMinor: number;
	readonly currency: string;
}

/** A US state's running figures. */
export interface UsStateTotals {
	readonly revenueUsdMinor: number;
	readonly transactions: number;
}

/** Every running total the thresholds read. */
export interface TurnoverTotals {
	/** This calendar year, place of supply in Bulgaria, euro cents. */
	readonly bgCalendarYearEurMinor: number;
	/** This calendar year, EU cross-border sales to buyers with no VAT number, euro cents. */
	readonly euCurrentYearEurMinor: number;
	/** The previous calendar year, the same total. */
	readonly euPreviousYearEurMinor: number;
	/** Per USPS state code: the larger of the trailing twelve months and the previous calendar year. */
	readonly usStates: ReadonlyMap<string, UsStateTotals>;
}

/** An amount converted to EUR minor units — exact for EUR, an overestimate for USD, `NaN` otherwise. */
export function eurMinorOf(amount: SaleAmount): number {
	const currency = amount.currency.toLowerCase();
	if (!Number.isFinite(amount.amountMinor)) return Number.NaN;
	if (currency === "eur") return amount.amountMinor;
	if (currency === "usd") return Math.ceil(amount.amountMinor * CONSERVATIVE_CROSS_RATE);
	return Number.NaN;
}

/** An amount converted to USD minor units — exact for USD, an overestimate for EUR, `NaN` otherwise. */
export function usdMinorOf(amount: SaleAmount): number {
	const currency = amount.currency.toLowerCase();
	if (!Number.isFinite(amount.amountMinor)) return Number.NaN;
	if (currency === "usd") return amount.amountMinor;
	if (currency === "eur") return Math.ceil(amount.amountMinor * CONSERVATIVE_CROSS_RATE);
	return Number.NaN;
}

/** One paid invoice row, as the sums read it. */
export interface TurnoverRow {
	readonly customerCountry: string | null;
	readonly customerState: string | null;
	readonly payerCapacity: PayerCapacity | null;
	readonly vatIdGiven: boolean | null;
	readonly amountEurMinor: number | null;
	readonly amountTotal: number;
	readonly currency: string;
	readonly paidAt: Date | null;
}

/** Midnight UTC on 1 January of `year`. */
function yearStart(year: number): Date {
	return new Date(Date.UTC(year, 0, 1));
}

/** The row's EUR figure: the recorded conversion when there is one, else the conservative one. */
function rowEurMinor(row: TurnoverRow): number {
	if (row.amountEurMinor !== null) return row.amountEurMinor;
	return eurMinorOf({ amountMinor: row.amountTotal, currency: row.currency });
}

/**
 * Sums paid rows into the totals, at `now`. Pure, so the counting rule is testable without a database.
 *
 * A row with no `paidAt` cannot be placed in a period, so it is counted in EVERY period it could fall
 * in — the current year, the previous year and the trailing twelve months — which over-counts, and
 * over-counting errs safe.
 */
export function sumTurnover(rows: readonly TurnoverRow[], now: Date): TurnoverTotals {
	const thisYear = now.getUTCFullYear();
	const currentStart = yearStart(thisYear);
	const previousStart = yearStart(thisYear - 1);
	const trailingStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

	let bg = 0;
	let euCurrent = 0;
	let euPrevious = 0;
	const trailing = new Map<string, { revenue: number; count: number }>();
	const previousYear = new Map<string, { revenue: number; count: number }>();

	for (const row of rows) {
		if (!row.customerCountry) continue;
		const counters = thresholdCountersForSale({
			country: row.customerCountry,
			capacity: row.payerCapacity,
			vatIdGiven: row.vatIdGiven,
			state: row.customerState,
		});
		if (counters.length === 0) continue;
		const paid = row.paidAt;
		const inCurrent = paid === null || paid >= currentStart;
		const inPrevious = paid === null || (paid >= previousStart && paid < currentStart);
		const inTrailing = paid === null || paid >= trailingStart;
		for (const counter of counters) {
			if (counter.id === "bg_place_of_supply") {
				if (inCurrent) bg += rowEurMinor(row);
			} else if (counter.id === "eu_cross_border_no_vat_id") {
				if (inCurrent) euCurrent += rowEurMinor(row);
				if (inPrevious) euPrevious += rowEurMinor(row);
			} else {
				// A US row with no usable state cannot be attributed, so it poisons EVERY state's total:
				// any state might be the one it belongs to.
				const key = counter.state ?? "*";
				const usd = usdMinorOf({ amountMinor: row.amountTotal, currency: row.currency });
				if (inTrailing) addTo(trailing, key, usd);
				if (inPrevious) addTo(previousYear, key, usd);
			}
		}
	}

	const usStates = new Map<string, UsStateTotals>();
	const unattributedTrailing = trailing.get("*");
	const unattributedPrevious = previousYear.get("*");
	const states = new Set([...trailing.keys(), ...previousYear.keys()]);
	states.delete("*");
	for (const state of states) {
		const t = trailing.get(state) ?? { revenue: 0, count: 0 };
		const p = previousYear.get(state) ?? { revenue: 0, count: 0 };
		usStates.set(state, {
			revenueUsdMinor: Math.max(t.revenue, p.revenue),
			transactions: Math.max(t.count, p.count),
		});
	}
	if (unattributedTrailing || unattributedPrevious) {
		usStates.set("*", {
			revenueUsdMinor: Number.NaN,
			transactions: Number.NaN,
		});
	}

	return {
		bgCalendarYearEurMinor: bg,
		euCurrentYearEurMinor: euCurrent,
		euPreviousYearEurMinor: euPrevious,
		usStates,
	};
}

/** Adds one sale to a state's running figures. */
function addTo(
	map: Map<string, { revenue: number; count: number }>,
	key: string,
	usdMinor: number,
): void {
	const prior = map.get(key) ?? { revenue: 0, count: 0 };
	map.set(key, { revenue: prior.revenue + usdMinor, count: prior.count + 1 });
}

/** A US state's totals, or `NaN` figures when an unattributed US sale exists (it could be this state's). */
function stateTotals(totals: TurnoverTotals, state: string | null): UsStateTotals {
	if (totals.usStates.has("*") || state === null) {
		return { revenueUsdMinor: Number.NaN, transactions: Number.NaN };
	}
	return totals.usStates.get(state) ?? { revenueUsdMinor: 0, transactions: 0 };
}

/** Narrows a stored capacity to a known one, or null. */
function narrowCapacity(value: string | null): PayerCapacity | null {
	return value === "consumer" || value === "organization" ? value : null;
}

/**
 * Reads the paid rows of the previous calendar year onward and sums them (`sumTurnover`). The earliest
 * period any threshold reads is the previous calendar year, which starts before the trailing twelve
 * months always does.
 */
export async function readTurnoverTotals(now: Date = new Date()): Promise<TurnoverTotals> {
	const rows = await getServiceDb()
		.select({
			customerCountry: invoice.customerCountry,
			customerState: invoice.customerState,
			payerCapacity: invoice.payerCapacity,
			vatIdGiven: invoice.vatIdGiven,
			amountEurMinor: invoice.amountEurMinor,
			amountTotal: invoice.amountTotal,
			currency: invoice.currency,
			paidAt: invoice.paidAt,
		})
		.from(invoice)
		.where(and(eq(invoice.status, "paid"), gte(invoice.createdAt, yearStart(now.getUTCFullYear() - 1))));
	return sumTurnover(
		rows.map((r) => ({ ...r, payerCapacity: narrowCapacity(r.payerCapacity) })),
		now,
	);
}

/** One counter's verdict for the next sale. */
export interface CounterAssessment {
	readonly counter: ThresholdCounter;
	readonly assessment: ThresholdAssessment;
}

/** The buyer as the gate sees them, for the counters their sale would add to. */
export interface ThresholdBuyer {
	readonly country: string;
	readonly capacity: PayerCapacity;
	readonly vatIdGiven: boolean | null;
	readonly state: string | null;
}

/**
 * Each counter this buyer's sale would add to, assessed against `totals` with the sale included.
 * Pure. An unknown sale amount is assessed as `0` — the total alone, which still stops a buyer once a
 * threshold has been crossed and warns as it nears.
 */
export function assessSaleAgainstTotals(
	buyer: ThresholdBuyer,
	sale: SaleAmount | null,
	totals: TurnoverTotals,
): CounterAssessment[] {
	const counters = thresholdCountersForSale(buyer);
	const saleEur = sale ? eurMinorOf(sale) : 0;
	const saleUsd = sale ? usdMinorOf(sale) : undefined;
	return counters.map((counter) => {
		if (counter.id === "bg_place_of_supply") {
			return {
				counter,
				assessment: bgThresholdAssessment({
					calendarYearEurMinor: totals.bgCalendarYearEurMinor,
					saleEurMinor: saleEur,
				}),
			};
		}
		if (counter.id === "eu_cross_border_no_vat_id") {
			return {
				counter,
				assessment: euCrossBorderThresholdAssessment({
					currentYearEurMinor: totals.euCurrentYearEurMinor,
					previousYearEurMinor: totals.euPreviousYearEurMinor,
					saleEurMinor: saleEur,
				}),
			};
		}
		const figures = stateTotals(totals, counter.state);
		return {
			counter,
			assessment: usStateThresholdAssessment({
				state: counter.state,
				revenueUsdMinor: figures.revenueUsdMinor,
				transactions: figures.transactions,
				saleUsdMinor: saleUsd,
			}),
		};
	});
}

/**
 * The counters this buyer's next sale would cross — the gate's question. Reads the database only when
 * the sale counts toward something: outside BG, the EU and the US there is nothing to read.
 */
export async function crossedThresholds(
	buyer: ThresholdBuyer,
	sale: SaleAmount | null,
	now: Date = new Date(),
): Promise<CounterAssessment[]> {
	if (thresholdCountersForSale(buyer).length === 0) return [];
	const totals = await readTurnoverTotals(now);
	return assessSaleAgainstTotals(buyer, sale, totals).filter(
		(c) => c.assessment.verdict === "stop",
	);
}
