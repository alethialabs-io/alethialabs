// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The purchase gate's threshold question (#7324, EA-2): would THIS sale cross a tax threshold?
//
// ONE CHECK. This file does no summing. The totals come from `assessSaleBeforeCharge`
// (lib/billing/turnover-facts.ts, EA-5's read, a leaf — see its header for the import cycle it avoids), which sums the paid invoice rows with `@repo/legal/turnover`
// — the same function the admin `/turnover` page calls — adds the prospective sale, and assesses it
// with EA-1's threshold rules. So the gate and the admin page read the same totals by construction
// (#7352): refunds and voids, recorded EUR rates, Bulgarian calendar years, US measuring periods and
// which counters a sale is attributed to are all decided in one place.
//
// What this file still owns is the sale's AMOUNT in the threshold's currency. A sale not yet taken
// has no recorded rate, so an EUR price assessed against a USD threshold (or the reverse) is
// converted with `CONSERVATIVE_CROSS_RATE` — a deliberate OVERESTIMATE, because counting too much
// stops a sale early and counting too little lets one cross.
//
// FAIL-CLOSED. A total EA-5 cannot read (an invoice with no EUR amount, a US invoice not billed in
// USD) is `NaN`, and EA-1 reads `NaN` as `stop`. A sale in a currency neither threshold is kept in
// converts to `NaN`, which is `stop` too. A database error throws, and the gate's caller treats a
// throw as a refusal. A broken counter must never read as room to sell.

import type { PayerCapacity } from "@repo/legal/commerce";
import { type ThresholdAssessment, type ThresholdCounter, thresholdCountersForSale } from "@repo/legal/thresholds";
import { assessSaleBeforeCharge, type TurnoverFactsReader } from "@/lib/billing/turnover-facts";

/**
 * The factor a USD amount is multiplied by to get an EUR figure, and an EUR amount to get a USD one,
 * when no recorded rate exists. 1.6 is above every EUR/USD and USD/EUR rate since the euro was
 * introduced (the pair has traded between about 0.82 and 1.60), so a converted figure is never below
 * the true one. Used only for the sale being priced.
 */
export const CONSERVATIVE_CROSS_RATE = 1.6;

/** An amount in minor units of a currency (Stripe's lower-case ISO code). */
export interface SaleAmount {
	readonly amountMinor: number;
	readonly currency: string;
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
 * The counters this buyer's next sale would cross — the gate's question — answered by EA-5's
 * `assessSaleBeforeCharge`. Reads the database only when the sale counts toward something: outside
 * BG, the EU and the US there is nothing to read. An unknown sale amount is assessed as `0` — the
 * totals alone, which still stops a buyer once a threshold has been crossed.
 */
export async function crossedThresholds(
	buyer: ThresholdBuyer,
	sale: SaleAmount | null,
	opts: { now?: Date; store?: TurnoverFactsReader } = {},
): Promise<CounterAssessment[]> {
	if (thresholdCountersForSale(buyer).length === 0) return [];
	const assessed = await assessSaleBeforeCharge(
		{
			country: buyer.country,
			capacity: buyer.capacity,
			vatIdGiven: buyer.vatIdGiven,
			state: buyer.state,
			amountEurMinor: sale ? eurMinorOf(sale) : 0,
			amountUsdMinor: sale ? usdMinorOf(sale) : 0,
		},
		opts,
	);
	return assessed.counters.filter((c) => c.assessment.verdict === "stop");
}
