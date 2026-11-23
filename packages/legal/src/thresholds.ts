// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tax thresholds an unregistered seller must stay under, and the ONE rule for reading a running
// total against them (#7320, EA-1).
//
// Pure constants and pure functions: no database, no clock, no exchange rate. The caller supplies
// the totals, already in the threshold's currency and for the threshold's period. Two callers read
// this file and must never disagree: the purchase gate (which refuses the sale with
// `threshold_reached`) and the admin turnover page (which shows how close each total is). Both call
// the same functions on the same totals, so the page cannot show "ok" while the gate refuses.
//
// The source for every figure is `docs/legal/TAX_MARKET_PRECONDITIONS.md` §2.1-2.3, §3.1, §3.5 and
// §3.6. It is not advice from a licensed adviser.

import { EU_MEMBER_STATES, type PayerCapacity, SELLER_COUNTRY } from "./commerce";

// ── Verdicts ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a total means for the NEXT sale.
 *
 *  - `ok` — the sale may go ahead and the total stays below the warning margin.
 *  - `warn` — the sale may go ahead, but the total after it is at or above the warning margin. The
 *    maintainer should be told, once per threshold.
 *  - `stop` — the sale must NOT be taken: it would cross the threshold, or the threshold is already
 *    crossed, or the input cannot be read. The check runs BEFORE the sale, because the sale that
 *    crosses the EU threshold is itself taxed in the buyer's member state (§3.5).
 */
export type ThresholdVerdict = "ok" | "warn" | "stop";

/** The verdicts from least to most severe. */
export const THRESHOLD_VERDICTS: readonly ThresholdVerdict[] = ["ok", "warn", "stop"];

/** A verdict with how far along the threshold the total is. */
export interface ThresholdAssessment {
	readonly verdict: ThresholdVerdict;
	/**
	 * The total after the sale divided by the threshold: `0.5` is half way, `1` is at it. For a
	 * threshold with two parts it is the part that decides (see `usStateThresholdAssessment`).
	 * `Infinity` when the input could not be read. `0` where there is no threshold. Sort by it to put
	 * the nearest threshold first.
	 */
	readonly usage: number;
}

/** The default warning margin: warn once a total reaches 80% of its threshold. */
export const DEFAULT_WARN_MARGIN = 0.8;

/**
 * How a limit is crossed.
 *
 *  - `exceeds` — crossed only when the total goes ABOVE the limit; a total exactly at it is still
 *    under. This is how the Bulgarian and EU texts are written ("надвиши", "не надвишава").
 *  - `reaches` — crossed when the total is at or above the limit. Used for the US, where the states
 *    word it both ways and the stricter reading is taken.
 */
export type ThresholdCrossing = "exceeds" | "reaches";

/** One limit on one running figure. */
export interface ThresholdLimit {
	/** The limit, in the figure's own unit: minor currency units, or a count of transactions. */
	readonly limit: number;
	readonly crossing: ThresholdCrossing;
}

/** The warning margin as a fraction in [0, 1]. Unreadable margins warn always, never never. */
function normaliseMargin(margin: number | undefined): number {
	if (margin === undefined) return DEFAULT_WARN_MARGIN;
	if (!Number.isFinite(margin)) return 0;
	return Math.min(1, Math.max(0, margin));
}

/** Whether a figure is a usable running total or sale: a finite number that is not negative. */
function readable(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

const UNREADABLE: ThresholdAssessment = { verdict: "stop", usage: Number.POSITIVE_INFINITY };

/**
 * The ONE rule: a running total, plus the sale about to be taken, against one limit.
 *
 * `stop` when the total after the sale would cross the limit — so the check refuses the sale that
 * WOULD cross, before it is taken, and a total that has already crossed stops every later sale.
 * `warn` when the total after the sale is at or above `warnMargin × limit`. `ok` otherwise.
 *
 * FAIL-CLOSED: a negative, `NaN` or infinite total or sale, or a limit that is not a positive
 * finite number, is `stop`. A broken counter must not read as room to sell.
 *
 * @param totalBefore the running total before this sale, in the limit's unit.
 * @param sale what this sale adds, in the same unit; `0` asks about the total alone.
 * @param warnMargin defaults to `DEFAULT_WARN_MARGIN`; clamped to [0, 1].
 */
export function assessThreshold(input: {
	readonly totalBefore: number;
	readonly sale: number;
	readonly threshold: ThresholdLimit;
	readonly warnMargin?: number;
}): ThresholdAssessment {
	const { totalBefore, sale, threshold } = input;
	if (!readable(totalBefore) || !readable(sale)) return UNREADABLE;
	if (!Number.isFinite(threshold.limit) || threshold.limit <= 0) return UNREADABLE;

	const after = totalBefore + sale;
	const usage = after / threshold.limit;
	const crossed =
		threshold.crossing === "exceeds" ? after > threshold.limit : after >= threshold.limit;
	if (crossed) return { verdict: "stop", usage };
	if (after >= normaliseMargin(input.warnMargin) * threshold.limit) {
		return { verdict: "warn", usage };
	}
	return { verdict: "ok", usage };
}

/** The more severe of two assessments; on a tie, the one further along. */
function worst(a: ThresholdAssessment, b: ThresholdAssessment): ThresholdAssessment {
	const rank = THRESHOLD_VERDICTS.indexOf(a.verdict) - THRESHOLD_VERDICTS.indexOf(b.verdict);
	if (rank !== 0) return rank > 0 ? a : b;
	return a.usage >= b.usage ? a : b;
}

/** The less severe of two assessments; on a tie, the one less far along. */
function least(a: ThresholdAssessment, b: ThresholdAssessment): ThresholdAssessment {
	const rank = THRESHOLD_VERDICTS.indexOf(a.verdict) - THRESHOLD_VERDICTS.indexOf(b.verdict);
	if (rank !== 0) return rank < 0 ? a : b;
	return a.usage <= b.usage ? a : b;
}

// ── Bulgaria: EUR 51,130 ────────────────────────────────────────────────────────────────────────

/**
 * The Bulgarian mandatory-registration threshold: EUR 51,130 of turnover with place of supply in
 * Bulgaria in a CALENDAR year (VAT Act Art. 96(1), counted under Art. 168c(1)), crossed when the
 * turnover EXCEEDS it. In euro cents.
 *
 * Counts: sales to Bulgarian buyers, and cross-border EU sales to buyers with no VAT number while
 * under the EUR 10,000 threshold (their place of supply is then Bulgaria, Art. 20b(2)). Does not
 * count: EU businesses that give a VAT number, and every sale outside the EU. `thresholdCountersForSale`
 * applies exactly this.
 */
export const BG_REGISTRATION_THRESHOLD: ThresholdLimit & {
	readonly currency: "EUR";
	readonly period: "calendar_year";
} = {
	limit: 51_130_00,
	crossing: "exceeds",
	currency: "EUR",
	period: "calendar_year",
};

/**
 * The Bulgarian threshold for the next sale.
 *
 * @param calendarYearEurMinor this calendar year's turnover with place of supply in Bulgaria, in
 *   euro cents, net of VAT, refunds deducted.
 * @param saleEurMinor the sale about to be taken, in euro cents; omit to read the total alone.
 */
export function bgThresholdAssessment(input: {
	readonly calendarYearEurMinor: number;
	readonly saleEurMinor?: number;
	readonly warnMargin?: number;
}): ThresholdAssessment {
	return assessThreshold({
		totalBefore: input.calendarYearEurMinor,
		sale: input.saleEurMinor ?? 0,
		threshold: BG_REGISTRATION_THRESHOLD,
		warnMargin: input.warnMargin,
	});
}

// ── EU cross-border sales to buyers with no VAT number: EUR 10,000 ─────────────────────────────

/**
 * The EU threshold for cross-border sales to buyers that give no VAT number (consumers, and
 * businesses that communicated none): EUR 10,000, net of VAT, ONE total across all other member
 * states together (VAT Act Art. 20b(1); Directive Art. 59c). In euro cents.
 *
 * It must not be exceeded in the current calendar year AND must not have been exceeded in the
 * previous one. The sale that crosses it is taxed in the buyer's member state (Art. 20b(3)), so the
 * check stops the sale BEFORE it is taken.
 */
export const EU_CROSS_BORDER_THRESHOLD: ThresholdLimit & {
	readonly currency: "EUR";
	readonly period: "calendar_year_and_previous";
} = {
	limit: 10_000_00,
	crossing: "exceeds",
	currency: "EUR",
	period: "calendar_year_and_previous",
};

/**
 * The EU cross-border threshold for the next sale.
 *
 * `stop` when the previous calendar year exceeded EUR 10,000, whatever this year says; otherwise
 * the rule of `assessThreshold` on this year's total plus the sale. `usage` is the larger of the
 * two years' fractions.
 *
 * @param currentYearEurMinor this calendar year's cross-border sales to buyers with no VAT number,
 *   in euro cents, net of VAT, refunds deducted.
 * @param previousYearEurMinor the same total for the previous calendar year.
 * @param saleEurMinor the sale about to be taken, in euro cents; omit to read the totals alone.
 */
export function euCrossBorderThresholdAssessment(input: {
	readonly currentYearEurMinor: number;
	readonly previousYearEurMinor: number;
	readonly saleEurMinor?: number;
	readonly warnMargin?: number;
}): ThresholdAssessment {
	const current = assessThreshold({
		totalBefore: input.currentYearEurMinor,
		sale: input.saleEurMinor ?? 0,
		threshold: EU_CROSS_BORDER_THRESHOLD,
		warnMargin: input.warnMargin,
	});
	const previous = assessThreshold({
		totalBefore: input.previousYearEurMinor,
		sale: 0,
		threshold: EU_CROSS_BORDER_THRESHOLD,
		warnMargin: input.warnMargin,
	});
	// Last year only ever STOPS this year. Nearing the limit last year is not a warning about this
	// year's next sale, so it does not raise `ok` to `warn` — but its fraction is still reported.
	if (previous.verdict === "stop") return { verdict: "stop", usage: previous.usage };
	return { verdict: current.verdict, usage: Math.max(current.usage, previous.usage) };
}

// ── United States: per state ────────────────────────────────────────────────────────────────────

/**
 * One state's economic-nexus threshold, in US cents and transactions.
 *
 *  - `revenue_or_transactions` — crossed when EITHER part is reached.
 *  - `revenue_and_transactions` — crossed only when BOTH parts are reached.
 *  - `revenue` — revenue alone.
 *  - `no_sales_tax` — the state has no general sales tax; there is nothing to cross.
 */
export type UsStateThreshold =
	| {
			readonly kind: "revenue_or_transactions";
			readonly revenueUsdMinor: number;
			readonly transactions: number;
	  }
	| {
			readonly kind: "revenue_and_transactions";
			readonly revenueUsdMinor: number;
			readonly transactions: number;
	  }
	| { readonly kind: "revenue"; readonly revenueUsdMinor: number }
	| { readonly kind: "no_sales_tax" };

const OR_100K_200: UsStateThreshold = {
	kind: "revenue_or_transactions",
	revenueUsdMinor: 100_000_00,
	transactions: 200,
};
const REVENUE_100K: UsStateThreshold = { kind: "revenue", revenueUsdMinor: 100_000_00 };
const REVENUE_250K: UsStateThreshold = { kind: "revenue", revenueUsdMinor: 250_000_00 };
const REVENUE_500K: UsStateThreshold = { kind: "revenue", revenueUsdMinor: 500_000_00 };
const NO_SALES_TAX: UsStateThreshold = { kind: "no_sales_tax" };

/**
 * Every US state, plus DC and Puerto Rico, keyed by USPS code, as Stripe's per-state pages gave them
 * on 2026-11-17 (`docs/legal/TAX_MARKET_PRECONDITIONS.md` §2.3). 52 entries.
 *
 * What is NOT encoded, and is the caller's: the measuring period (it differs by state — previous
 * calendar year, current or previous year, trailing twelve months, last four quarters), and whether
 * the state counts a subscription at all. The caller passes totals for the STRICTEST period it can
 * measure; the trailing twelve months covers every listed period except "previous calendar year".
 * Alaska has no state sales tax; its threshold is for local taxes.
 */
export const US_STATE_THRESHOLDS: Readonly<Record<string, UsStateThreshold>> = {
	AL: REVENUE_250K,
	AK: REVENUE_100K,
	AZ: REVENUE_100K,
	AR: OR_100K_200,
	CA: REVENUE_500K,
	CO: REVENUE_100K,
	CT: { kind: "revenue_and_transactions", revenueUsdMinor: 100_000_00, transactions: 200 },
	DE: NO_SALES_TAX,
	DC: OR_100K_200,
	FL: REVENUE_100K,
	GA: OR_100K_200,
	HI: OR_100K_200,
	ID: REVENUE_100K,
	IL: REVENUE_100K,
	IN: REVENUE_100K,
	IA: REVENUE_100K,
	KS: REVENUE_100K,
	KY: REVENUE_100K,
	LA: REVENUE_100K,
	ME: OR_100K_200,
	MD: OR_100K_200,
	MA: REVENUE_100K,
	MI: OR_100K_200,
	MN: OR_100K_200,
	MS: REVENUE_250K,
	MO: REVENUE_100K,
	MT: NO_SALES_TAX,
	NE: OR_100K_200,
	NV: OR_100K_200,
	NH: NO_SALES_TAX,
	NJ: OR_100K_200,
	NM: REVENUE_100K,
	NY: { kind: "revenue_and_transactions", revenueUsdMinor: 500_000_00, transactions: 100 },
	NC: OR_100K_200,
	ND: REVENUE_100K,
	OH: OR_100K_200,
	OK: REVENUE_100K,
	OR: NO_SALES_TAX,
	PA: REVENUE_100K,
	PR: OR_100K_200,
	RI: OR_100K_200,
	SC: REVENUE_100K,
	SD: REVENUE_100K,
	TN: REVENUE_100K,
	TX: REVENUE_500K,
	UT: REVENUE_100K,
	VT: OR_100K_200,
	VA: OR_100K_200,
	WA: REVENUE_100K,
	WV: OR_100K_200,
	WI: REVENUE_100K,
	WY: OR_100K_200,
};

/** A USPS state code as an upper-case two-letter key, or `null` when it is missing or malformed. */
function normaliseState(state: string | null | undefined): string | null {
	if (!state) return null;
	const code = state.trim().toUpperCase();
	return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * The threshold for a USPS state code (case-insensitive), or `null` when the code is missing or is
 * not one of the 52 listed. The purchase gate uses `null` to refuse a US sale with no usable state:
 * a sale that cannot be attributed to a state cannot be counted against any threshold.
 */
export function usStateThreshold(state: string | null | undefined): UsStateThreshold | null {
	const code = normaliseState(state);
	if (code === null) return null;
	return US_STATE_THRESHOLDS[code] ?? null;
}

/**
 * One US state's threshold for the next sale.
 *
 * Each part is read with `assessThreshold`, crossing on REACHING the figure (the stricter reading),
 * and a sale adds its amount to revenue and one to the transaction count. Then:
 *
 *  - `revenue_or_transactions` — the more severe part decides (either part crossing stops);
 *  - `revenue_and_transactions` — the less severe part decides (both must cross to stop);
 *  - `revenue` — revenue alone;
 *  - `no_sales_tax` — always `ok`, `usage` 0.
 *
 * FAIL-CLOSED: a missing or unknown state is `stop`, as is an unreadable figure.
 *
 * @param revenueUsdMinor the state's running revenue, in US cents, refunds deducted.
 * @param transactions the state's running count of sales.
 * @param saleUsdMinor the sale about to be taken, in US cents; omit to read the totals alone.
 */
export function usStateThresholdAssessment(input: {
	readonly state: string | null | undefined;
	readonly revenueUsdMinor: number;
	readonly transactions: number;
	readonly saleUsdMinor?: number;
	readonly warnMargin?: number;
}): ThresholdAssessment {
	const rule = usStateThreshold(input.state);
	if (rule === null) return UNREADABLE;
	if (rule.kind === "no_sales_tax") {
		const counted = readable(input.revenueUsdMinor) && readable(input.transactions);
		return counted ? { verdict: "ok", usage: 0 } : UNREADABLE;
	}
	const isSale = input.saleUsdMinor !== undefined;
	const revenue = assessThreshold({
		totalBefore: input.revenueUsdMinor,
		sale: input.saleUsdMinor ?? 0,
		threshold: { limit: rule.revenueUsdMinor, crossing: "reaches" },
		warnMargin: input.warnMargin,
	});
	if (rule.kind === "revenue") return revenue;
	const transactions = assessThreshold({
		totalBefore: input.transactions,
		sale: isSale ? 1 : 0,
		threshold: { limit: rule.transactions, crossing: "reaches" },
		warnMargin: input.warnMargin,
	});
	if (revenue.verdict === "stop" && revenue.usage === Number.POSITIVE_INFINITY) return UNREADABLE;
	if (transactions.verdict === "stop" && transactions.usage === Number.POSITIVE_INFINITY) {
		return UNREADABLE;
	}
	return rule.kind === "revenue_or_transactions"
		? worst(revenue, transactions)
		: least(revenue, transactions);
}

// ── Which counters a sale counts toward ─────────────────────────────────────────────────────────

/** A running total a sale is added to. */
export type ThresholdCounter =
	| { readonly id: "bg_place_of_supply" }
	| { readonly id: "eu_cross_border_no_vat_id" }
	| {
			readonly id: "us_state";
			/** The USPS code, upper-case, or `null` when the sale has no usable state. */
			readonly state: string | null;
	  };

/**
 * The counters a sale is added to, decided from the buyer as declared at the time of the sale. The
 * turnover snapshot and the purchase gate both call this, so they count the same sales.
 *
 *  - Bulgaria, any capacity: the Bulgarian total.
 *  - Another EU member state, a consumer or an organization that gave NO VAT number: the EU
 *    cross-border total AND the Bulgarian total (below EUR 10,000 the place of supply is Bulgaria).
 *    An organization whose status is undeclared is counted the same way: counting a sale that did
 *    not need it errs safe, missing one does not.
 *  - Another EU member state, an organization that gave a VAT number: nothing (reverse charge,
 *    place of supply outside Bulgaria).
 *  - The United States: that state's counter.
 *  - Anywhere else, or an unreadable country or capacity: nothing.
 */
export function thresholdCountersForSale(sale: {
	readonly country: string | null | undefined;
	readonly capacity: PayerCapacity | null | undefined;
	readonly vatIdGiven: boolean | null | undefined;
	readonly state?: string | null;
}): readonly ThresholdCounter[] {
	const country = sale.country?.trim().toUpperCase() ?? "";
	if (!/^[A-Z]{2}$/.test(country)) return [];
	if (sale.capacity !== "consumer" && sale.capacity !== "organization") return [];
	if (country === SELLER_COUNTRY) return [{ id: "bg_place_of_supply" }];
	if (EU_MEMBER_STATES.includes(country)) {
		if (sale.capacity === "organization" && sale.vatIdGiven === true) return [];
		return [{ id: "eu_cross_border_no_vat_id" }, { id: "bg_place_of_supply" }];
	}
	if (country === "US") return [{ id: "us_state", state: normaliseState(sale.state) }];
	return [];
}
