// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The running totals behind the tax thresholds, summed from the per-invoice facts the console
// snapshots at payment (#7327, EA-5), and read against the rules of `./thresholds` (EA-1).
//
// Pure: the caller loads the invoice rows and supplies `now`. Two callers read this file — the
// console's purchase gate (through `apps/console/lib/billing/invoice-facts.ts`) and the admin
// `/turnover` page — and both sum the SAME rows with the SAME function, then assess the result with
// the SAME EA-1 functions. That is what keeps the page from showing "ok" while the gate refuses.
//
// What is counted, and how:
//
//  - Only `paid` invoices. A voided or fully refunded invoice has its status changed by the webhook
//    and drops out of every total. A PARTIAL refund is not recorded anywhere, so it does not reduce
//    a total: the totals then read high, which stops a sale early rather than late.
//  - Which counters an invoice counts toward is `thresholdCountersForSale` on the buyer AS DECLARED
//    when it paid (the snapshot), never on the organization's current declaration.
//  - The Bulgarian and EU totals are in euro cents, from the snapshot's `amountEurMinor`. An invoice
//    that counts toward them with no EUR amount makes that total UNREADABLE, and an unreadable total
//    is `stop` (EA-1 fails closed on `NaN`). A broken conversion must not read as room to sell.
//  - A US state's totals are in US cents, from the invoice amount when it was billed in USD. One
//    billed in another currency makes that state's totals unreadable, for the same reason.
//  - A paid invoice with no snapshot at all (no country and no capacity) is UNATTRIBUTED: its facts
//    were never recorded. One billed in EUR is counted toward the EU and the Bulgarian totals, which
//    is where an EUR invoice can belong (EU buyers are billed in EUR) and which errs high; any other
//    is counted only in `unattributed`, which the admin page shows.
//
// The calendar years are Bulgarian (Europe/Sofia): the BG and EU rules are Bulgarian law. The US
// measuring period differs by state (EA-1 leaves it to the caller), so each US figure is the LARGEST
// of the previous calendar year, the trailing twelve months, and the last four complete quarters,
// which is at least every period the states use.

import type { PayerCapacity } from "./commerce";
import {
	bgThresholdAssessment,
	euCrossBorderThresholdAssessment,
	THRESHOLD_VERDICTS,
	type ThresholdAssessment,
	type ThresholdCounter,
	type ThresholdVerdict,
	thresholdCountersForSale,
	usStateThresholdAssessment,
} from "./thresholds";

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** One invoice row, as the turnover totals read it. Columns of the console's `invoice` table. */
export interface TurnoverFact {
	/** `paid`, `refunded` or `void`; only `paid` counts. */
	readonly status: string;
	/** When it was paid. A row with no date is not in any period and is not counted. */
	readonly paidAt: Date | null;
	/** ISO currency code of `amountMinor`, any case. */
	readonly currency: string;
	/** The invoice total in `currency`'s minor unit. */
	readonly amountMinor: number;
	/** The invoice total in euro cents, from the snapshot; null when no rate was recorded. */
	readonly amountEurMinor: number | null;
	/** Snapshot: the buyer's country (ISO alpha-2). */
	readonly country: string | null;
	/** Snapshot: the buyer's USPS state code, for a US buyer. */
	readonly state: string | null;
	/** Snapshot: the buyer's declared capacity. */
	readonly capacity: PayerCapacity | null;
	/** Snapshot: whether the buyer had declared a VAT number. */
	readonly vatIdGiven: boolean | null;
}

// ── Totals ──────────────────────────────────────────────────────────────────────────────────────

/** A euro total for one period. */
export interface EurTotal {
	/** Euro cents summed over the invoices that had an EUR amount. */
	readonly eurMinor: number;
	/** How many invoices were counted, converted or not. */
	readonly invoices: number;
	/** How many counted invoices had no EUR amount. Above zero, the total is unreadable. */
	readonly unconverted: number;
}

/** One US state's totals, each the largest over the measuring periods (see the file header). */
export interface UsStateTotal {
	/** USPS code, upper-case. */
	readonly state: string;
	readonly revenueUsdMinor: number;
	readonly transactions: number;
	/** Counted invoices not billed in USD. Above zero, the state's totals are unreadable. */
	readonly unconverted: number;
}

/** Every running total the thresholds read, as of one moment. */
export interface TurnoverTotals {
	/** The Bulgarian calendar year the BG and current-year EU totals are for. */
	readonly year: number;
	/** Turnover with place of supply in Bulgaria, this calendar year. */
	readonly bg: EurTotal;
	/** Cross-border EU sales to buyers with no VAT number, this calendar year. */
	readonly euCurrent: EurTotal;
	/** The same, the previous calendar year. */
	readonly euPrevious: EurTotal;
	/** Every US state with at least one counted sale, by USPS code. */
	readonly usStates: readonly UsStateTotal[];
	/** US sales whose snapshot has no usable state: counted toward no state, shown to the operator. */
	readonly usNoState: { readonly invoices: number; readonly revenueUsdMinor: number };
	/** Paid invoices with no snapshot that could not be attributed anywhere (not billed in EUR). */
	readonly unattributed: { readonly invoices: number };
}

/** The Bulgarian calendar year a moment falls in. */
export function bulgarianYear(at: Date): number {
	return Number(
		new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric" }).format(at),
	);
}

/**
 * The earliest moment any total as of `now` reads: midnight UTC on 31 December two years back,
 * which is before the start of the previous Bulgarian calendar year (and so before the trailing
 * twelve months and the last four quarters too). Callers load invoices paid at or after it.
 */
export function turnoverWindowStart(now: Date): Date {
	return new Date(Date.UTC(bulgarianYear(now) - 2, 11, 31));
}

/** A half-open window [from, to). */
interface Window {
	readonly from: number;
	readonly to: number;
}

/** The US measuring windows as of `now`: previous calendar year, trailing 12 months, last 4 quarters. */
function usWindows(now: Date): readonly Window[] {
	const y = now.getUTCFullYear();
	const end = now.getTime() + 1;
	const quarterStart = Date.UTC(y, Math.floor(now.getUTCMonth() / 3) * 3, 1);
	const yearBefore = new Date(now);
	yearBefore.setUTCFullYear(y - 1);
	const fourQuartersBack = new Date(quarterStart);
	fourQuartersBack.setUTCFullYear(y - 1);
	return [
		{ from: Date.UTC(y - 1, 0, 1), to: Date.UTC(y, 0, 1) },
		{ from: yearBefore.getTime(), to: end },
		{ from: fourQuartersBack.getTime(), to: quarterStart },
	];
}

/** A mutable EUR accumulator. */
interface EurSum {
	eurMinor: number;
	invoices: number;
	unconverted: number;
}

/** Adds one invoice to a EUR accumulator. */
function addEur(sum: EurSum, eurMinor: number | null): void {
	sum.invoices += 1;
	if (eurMinor === null || !Number.isFinite(eurMinor)) sum.unconverted += 1;
	else sum.eurMinor += eurMinor;
}

/** The counters a fact counts toward, with the unattributed-EUR rule of the file header. */
function countersOf(fact: TurnoverFact): readonly ThresholdCounter[] | "unattributed" {
	if (fact.country === null && fact.capacity === null) {
		return fact.currency.toLowerCase() === "eur"
			? [{ id: "eu_cross_border_no_vat_id" }, { id: "bg_place_of_supply" }]
			: "unattributed";
	}
	return thresholdCountersForSale({
		country: fact.country,
		capacity: fact.capacity,
		vatIdGiven: fact.vatIdGiven,
		state: fact.state,
	});
}

/** The EUR amount of a fact: the snapshot's, or the invoice amount itself when it was billed in EUR. */
function eurAmountOf(fact: TurnoverFact): number | null {
	if (fact.amountEurMinor !== null) return fact.amountEurMinor;
	return fact.currency.toLowerCase() === "eur" ? fact.amountMinor : null;
}

/**
 * Sums the invoice facts into every running total, as of `now`. Rows outside the periods, rows not
 * `paid`, and rows with no payment date are skipped, so the caller may pass a superset.
 */
export function turnoverTotals(facts: readonly TurnoverFact[], now: Date): TurnoverTotals {
	const year = bulgarianYear(now);
	const bg: EurSum = { eurMinor: 0, invoices: 0, unconverted: 0 };
	const euCurrent: EurSum = { eurMinor: 0, invoices: 0, unconverted: 0 };
	const euPrevious: EurSum = { eurMinor: 0, invoices: 0, unconverted: 0 };
	const windows = usWindows(now);
	// Per state, per window: [revenue, transactions, unconverted].
	const us = new Map<string, number[][]>();
	const usNoState = { invoices: 0, revenueUsdMinor: 0 };
	const unattributed = { invoices: 0 };
	const nowMs = now.getTime();

	for (const fact of facts) {
		if (fact.status !== "paid" || fact.paidAt === null) continue;
		const at = fact.paidAt.getTime();
		if (!Number.isFinite(at) || at > nowMs) continue;
		const counters = countersOf(fact);
		const paidYear = bulgarianYear(fact.paidAt);
		if (counters === "unattributed") {
			if (paidYear >= year - 1) unattributed.invoices += 1;
			continue;
		}
		for (const counter of counters) {
			if (counter.id === "bg_place_of_supply") {
				if (paidYear === year) addEur(bg, eurAmountOf(fact));
			} else if (counter.id === "eu_cross_border_no_vat_id") {
				if (paidYear === year) addEur(euCurrent, eurAmountOf(fact));
				else if (paidYear === year - 1) addEur(euPrevious, eurAmountOf(fact));
			} else {
				const usd = fact.currency.toLowerCase() === "usd" ? fact.amountMinor : null;
				if (counter.state === null) {
					if (windows.some((w) => at >= w.from && at < w.to)) {
						usNoState.invoices += 1;
						usNoState.revenueUsdMinor += usd ?? 0;
					}
					continue;
				}
				const perWindow = us.get(counter.state) ?? windows.map(() => [0, 0, 0]);
				windows.forEach((w, i) => {
					const cell = perWindow[i];
					if (!cell || at < w.from || at >= w.to) return;
					cell[0] = (cell[0] ?? 0) + (usd ?? 0);
					cell[1] = (cell[1] ?? 0) + 1;
					if (usd === null) cell[2] = (cell[2] ?? 0) + 1;
				});
				us.set(counter.state, perWindow);
			}
		}
	}

	const usStates: UsStateTotal[] = [];
	for (const [state, perWindow] of us) {
		const max = (k: number): number => Math.max(...perWindow.map((cell) => cell[k] ?? 0));
		if (max(1) === 0) continue;
		usStates.push({ state, revenueUsdMinor: max(0), transactions: max(1), unconverted: max(2) });
	}
	usStates.sort((a, b) => a.state.localeCompare(b.state));

	return { year, bg, euCurrent, euPrevious, usStates, usNoState, unattributed };
}

// ── Assessments ─────────────────────────────────────────────────────────────────────────────────

/** A EUR total as EA-1 reads it: `NaN` when any counted invoice is unconverted, so it fails closed. */
function readableEur(total: EurTotal): number {
	return total.unconverted > 0 ? Number.NaN : total.eurMinor;
}

/** A US state's totals, with their assessment. */
export interface UsStateAssessment extends UsStateTotal {
	readonly assessment: ThresholdAssessment;
}

/** Every total read against its threshold. */
export interface TurnoverAssessments {
	readonly year: number;
	/** BG EUR 51,130, this calendar year. */
	readonly bg: ThresholdAssessment;
	/** EU EUR 10,000, this year and last year. */
	readonly eu: ThresholdAssessment;
	/** One per state with a counted sale, nearest threshold first. */
	readonly usStates: readonly UsStateAssessment[];
}

/** Reads every total against its threshold, with nothing more being sold. */
export function assessTurnover(totals: TurnoverTotals, warnMargin?: number): TurnoverAssessments {
	const usStates = totals.usStates
		.map((s) => ({
			...s,
			assessment: usStateThresholdAssessment({
				state: s.state,
				revenueUsdMinor: s.unconverted > 0 ? Number.NaN : s.revenueUsdMinor,
				transactions: s.transactions,
				warnMargin,
			}),
		}))
		.sort((a, b) => b.assessment.usage - a.assessment.usage || a.state.localeCompare(b.state));
	return {
		year: totals.year,
		bg: bgThresholdAssessment({ calendarYearEurMinor: readableEur(totals.bg), warnMargin }),
		eu: euCrossBorderThresholdAssessment({
			currentYearEurMinor: readableEur(totals.euCurrent),
			previousYearEurMinor: readableEur(totals.euPrevious),
			warnMargin,
		}),
		usStates,
	};
}

/** The sale the purchase gate is about to take, described as the snapshot will record it. */
export interface ProspectiveSale {
	readonly country: string | null | undefined;
	readonly capacity: PayerCapacity | null | undefined;
	readonly vatIdGiven: boolean | null | undefined;
	readonly state?: string | null;
	/** The sale in euro cents; needed when it counts toward the BG or EU totals. */
	readonly amountEurMinor?: number;
	/** The sale in US cents; needed when it counts toward a US state. */
	readonly amountUsdMinor?: number;
}

/** What the next sale would do to each total it counts toward. */
export interface SaleAssessment extends ThresholdAssessment {
	readonly counters: readonly {
		readonly counter: ThresholdCounter;
		readonly assessment: ThresholdAssessment;
	}[];
}

/** The more severe of two assessments; on a tie, the one further along. */
function worse(a: ThresholdAssessment, b: ThresholdAssessment): ThresholdAssessment {
	const rank = THRESHOLD_VERDICTS.indexOf(a.verdict) - THRESHOLD_VERDICTS.indexOf(b.verdict);
	if (rank !== 0) return rank > 0 ? a : b;
	return a.usage >= b.usage ? a : b;
}

/**
 * The check the purchase gate runs BEFORE it takes a sale: each total the sale counts toward, with
 * the sale added. `stop` means the sale would cross a threshold (or a total is already crossed, or
 * cannot be read) and must not be taken — the sale that crosses the EU threshold is itself taxed in
 * the buyer's member state (TAX §3.5). A sale that counts toward nothing is `ok`. An amount the
 * sale needs and the caller did not pass is `stop`.
 */
export function assessSaleAgainstTurnover(
	totals: TurnoverTotals,
	sale: ProspectiveSale,
	warnMargin?: number,
): SaleAssessment {
	const counters = thresholdCountersForSale(sale).map((counter) => {
		const eurSale = sale.amountEurMinor ?? Number.NaN;
		if (counter.id === "bg_place_of_supply") {
			const assessment = bgThresholdAssessment({
				calendarYearEurMinor: readableEur(totals.bg),
				saleEurMinor: eurSale,
				warnMargin,
			});
			return { counter, assessment };
		}
		if (counter.id === "eu_cross_border_no_vat_id") {
			const assessment = euCrossBorderThresholdAssessment({
				currentYearEurMinor: readableEur(totals.euCurrent),
				previousYearEurMinor: readableEur(totals.euPrevious),
				saleEurMinor: eurSale,
				warnMargin,
			});
			return { counter, assessment };
		}
		const current = totals.usStates.find((s) => s.state === counter.state);
		const assessment = usStateThresholdAssessment({
			state: counter.state,
			revenueUsdMinor:
				current && current.unconverted > 0 ? Number.NaN : (current?.revenueUsdMinor ?? 0),
			transactions: current?.transactions ?? 0,
			saleUsdMinor: sale.amountUsdMinor ?? Number.NaN,
			warnMargin,
		});
		return { counter, assessment };
	});
	const overall = counters
		.map((c) => c.assessment)
		.reduce<ThresholdAssessment>(worse, { verdict: "ok", usage: 0 });
	return { ...overall, counters };
}

// ── Alerts ──────────────────────────────────────────────────────────────────────────────────────

/** A threshold whose verdict got more severe between two readings of the totals. */
export interface ThresholdEscalation {
	/** Stable per threshold and period, e.g. `bg:2027`, `eu:2027`, `us:NY`. */
	readonly key: string;
	/** What a person reads: "Bulgaria EUR 51,130 (2027)". */
	readonly label: string;
	readonly from: ThresholdVerdict;
	readonly to: ThresholdVerdict;
	readonly usage: number;
}

/** The rank of a verdict, least severe first. */
function rankOf(verdict: ThresholdVerdict): number {
	return THRESHOLD_VERDICTS.indexOf(verdict);
}

/**
 * The thresholds whose verdict rose from `before` to `after` and is now `warn` or `stop`. The
 * console calls it around recording ONE invoice, under a lock, so each rise is seen by exactly one
 * invoice: the alert fires once when a total reaches the warning margin, and once more if it then
 * reaches the threshold. A total that falls back (a refund) and rises again alerts again.
 */
export function thresholdEscalations(
	before: TurnoverAssessments,
	after: TurnoverAssessments,
): ThresholdEscalation[] {
	const out: ThresholdEscalation[] = [];
	const check = (key: string, label: string, a: ThresholdAssessment, b: ThresholdAssessment) => {
		if (b.verdict !== "ok" && rankOf(b.verdict) > rankOf(a.verdict)) {
			out.push({ key, label, from: a.verdict, to: b.verdict, usage: b.usage });
		}
	};
	check(`bg:${after.year}`, `Bulgaria EUR 51,130 (${after.year})`, before.bg, after.bg);
	check(`eu:${after.year}`, `EU cross-border EUR 10,000 (${after.year})`, before.eu, after.eu);
	const ok: ThresholdAssessment = { verdict: "ok", usage: 0 };
	for (const s of after.usStates) {
		const prior = before.usStates.find((p) => p.state === s.state)?.assessment ?? ok;
		check(`us:${s.state}`, `US state ${s.state}`, prior, s.assessment);
	}
	return out;
}
