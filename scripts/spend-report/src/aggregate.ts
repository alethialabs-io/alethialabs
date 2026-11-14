// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReportWindow } from "./dates";
import { toEur, type FxRates } from "./fx";
import {
	CLOUD_LABEL,
	CLOUDS,
	type Basis,
	type CloudId,
	type CloudResult,
	type Leak,
	type LeakResult,
	type LineItem,
	type Thresholds,
} from "./types";

/** One day's spend on one key (a service, a tag value), as the daily provider queries return it. */
export interface DailyRow {
	/** `YYYY-MM-DD`. */
	date: string;
	key: string;
	amount: number;
}

/** The three window totals plus the last-7-day spend per key, from a set of daily rows. */
export interface Buckets {
	last7: number;
	prior7: number;
	/** `null` on the 1st of the month — there is no complete day to add up yet. */
	mtd: number | null;
	byKeyLast7: LineItem[];
}

/**
 * Adds daily rows into the report's windows. A row outside every window is ignored rather than
 * mis-bucketed, so a provider that returns a wider range than asked for cannot inflate a total.
 */
export function bucketDaily(rows: DailyRow[], w: ReportWindow): Buckets {
	let last7 = 0;
	let prior7 = 0;
	let mtd = 0;
	const byKey = new Map<string, number>();
	for (const r of rows) {
		if (!Number.isFinite(r.amount)) continue;
		if (r.date >= w.last7Start && r.date < w.today) {
			last7 += r.amount;
			byKey.set(r.key, (byKey.get(r.key) ?? 0) + r.amount);
		} else if (r.date >= w.prior7Start && r.date < w.last7Start) {
			prior7 += r.amount;
		}
		if (r.date >= w.monthStart && r.date < w.today) mtd += r.amount;
	}
	return {
		last7,
		prior7,
		mtd: w.daysElapsedInMonth === 0 ? null : mtd,
		byKeyLast7: sortItems([...byKey].map(([label, amount]) => ({ label, amount }))),
	};
}

/** Sorts line items by amount, largest first, dropping the ones that round to zero. */
export function sortItems(items: LineItem[]): LineItem[] {
	return items.filter((i) => Math.abs(i.amount) >= 0.005).sort((a, b) => b.amount - a.amount);
}

/** Week-on-week change. `pct` is null when there is nothing to compare against. */
export interface Delta {
	abs: number;
	pct: number | null;
}

/** Computes the change from `prior` to `last`; null when either side is unknown. */
export function wowDelta(last: number | null, prior: number | null): Delta | null {
	if (last === null || prior === null) return null;
	const abs = last - prior;
	return { abs, pct: prior === 0 ? null : (abs / prior) * 100 };
}

/** The per-cloud red-flag ceilings when no repo variable overrides them (EUR per 7 days). */
export const DEFAULT_THRESHOLDS: Thresholds = {
	aws: 30,
	azure: 15,
	gcp: 15,
	hetzner: 30,
	alibaba: 10,
};

/**
 * Reads `SPEND_REPORT_THRESHOLDS_EUR` — a JSON object of per-cloud overrides, e.g. `{"aws":50}`.
 * Unknown keys and non-positive numbers are refused with a warning; a malformed value falls back to
 * the defaults and SAYS so in the email, rather than silently flagging nothing.
 */
export function parseThresholds(raw: string | undefined): { thresholds: Thresholds; warnings: string[] } {
	const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
	const warnings: string[] = [];
	if (!raw || raw.trim() === "") return { thresholds, warnings };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnings.push("SPEND_REPORT_THRESHOLDS_EUR is not valid JSON — the default thresholds were used.");
		return { thresholds, warnings };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push("SPEND_REPORT_THRESHOLDS_EUR must be a JSON object like {\"aws\": 50} — the default thresholds were used.");
		return { thresholds, warnings };
	}
	for (const [k, v] of Object.entries(parsed)) {
		const cloud = CLOUDS.find((c) => c === k);
		if (!cloud) {
			warnings.push(`SPEND_REPORT_THRESHOLDS_EUR: unknown cloud "${k}" ignored.`);
			continue;
		}
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
			warnings.push(`SPEND_REPORT_THRESHOLDS_EUR: ${k} must be a positive number — default ${DEFAULT_THRESHOLDS[cloud]} kept.`);
			continue;
		}
		thresholds[cloud] = v;
	}
	return { thresholds, warnings };
}

/** One cloud's row in the report, every amount also in EUR. */
export interface ReportRow {
	cloud: CloudId;
	label: string;
	status: "ok" | "unreadable";
	reason?: string;
	currency?: string;
	estimate: boolean;
	last7: number | null;
	prior7: number | null;
	mtd: number | null;
	last7Eur: number | null;
	prior7Eur: number | null;
	mtdEur: number | null;
	wow: Delta | null;
	notes: string[];
	breakdowns: { title: string; items: { label: string; amount: number; amountEur: number | null }[] }[];
	/** The threshold this cloud was held to, and the figure compared with it. */
	threshold: number;
	compared: { eur: number; basis: "7d" | "mtd-prorated" | "est-7d" } | null;
	flagged: boolean;
}

/** A line item ranked across every cloud. */
export interface TopItem {
	cloud: CloudId;
	label: string;
	amount: number;
	currency: string;
	amountEur: number | null;
	basis: Basis;
}

/** Everything the renderers need, already computed. */
export interface Report {
	window: ReportWindow;
	rows: ReportRow[];
	totals: {
		last7Eur: number;
		prior7Eur: number;
		mtdEur: number;
		wow: Delta | null;
		/** Clouds whose 7-day figure is missing or unconvertible, so the total leaves them out. */
		excludedFromLast7: CloudId[];
		/** True when any cloud in the 7-day total is an estimate. */
		includesEstimate: boolean;
	};
	top: TopItem[];
	leaks: Leak[];
	leakScans: { cloud: CloudId; status: "ok" | "unreadable"; detail: string }[];
	flags: string[];
	fx: { date: string | null; missing: string[] };
	warnings: string[];
}

/** Converts, or returns null when either the amount or its rate is unknown. */
function eur(amount: number | null, currency: string, fx: FxRates): number | null {
	return amount === null ? null : toEur(amount, currency, fx);
}

/** Converts an MTD figure into a seven-day equivalent, so a cloud that only reports MTD can still be held to a weekly threshold. */
export function prorateMtdToWeek(mtdEur: number, daysElapsed: number): number | null {
	return daysElapsed > 0 ? (mtdEur * 7) / daysElapsed : null;
}

/** Builds the report model from every source's result. Pure. */
export function buildReport(args: {
	window: ReportWindow;
	results: CloudResult[];
	leakResults: LeakResult[];
	fx: FxRates;
	thresholds: Thresholds;
	warnings: string[];
	topN?: number;
}): Report {
	const { window: w, fx, thresholds } = args;
	const missingFx = new Set<string>();
	const rows: ReportRow[] = [];
	const allItems: TopItem[] = [];

	for (const cloud of CLOUDS) {
		const r = args.results.find((x) => x.cloud === cloud);
		if (!r) continue;
		if (r.status === "unreadable") {
			rows.push({
				cloud,
				label: CLOUD_LABEL[cloud],
				status: "unreadable",
				reason: r.reason,
				estimate: false,
				last7: null,
				prior7: null,
				mtd: null,
				last7Eur: null,
				prior7Eur: null,
				mtdEur: null,
				wow: null,
				notes: [],
				breakdowns: [],
				threshold: thresholds[cloud],
				compared: null,
				flagged: false,
			});
			continue;
		}
		if (toEur(1, r.currency, fx) === null) missingFx.add(r.currency);
		const last7Eur = eur(r.last7, r.currency, fx);
		const prior7Eur = eur(r.prior7, r.currency, fx);
		const mtdEur = eur(r.mtd, r.currency, fx);

		let compared: ReportRow["compared"] = null;
		if (last7Eur !== null) {
			compared = { eur: last7Eur, basis: r.estimate ? "est-7d" : "7d" };
		} else if (mtdEur !== null) {
			const wk = prorateMtdToWeek(mtdEur, w.daysElapsedInMonth);
			if (wk !== null) compared = { eur: wk, basis: "mtd-prorated" };
		}
		const flagged = compared !== null && compared.eur > thresholds[cloud];

		rows.push({
			cloud,
			label: CLOUD_LABEL[cloud],
			status: "ok",
			currency: r.currency,
			estimate: r.estimate,
			last7: r.last7,
			prior7: r.prior7,
			mtd: r.mtd,
			last7Eur,
			prior7Eur,
			mtdEur,
			wow: wowDelta(r.last7, r.prior7),
			notes: r.notes,
			breakdowns: r.breakdowns.map((b) => ({
				title: b.title,
				items: b.items.map((i) => ({ ...i, amountEur: toEur(i.amount, r.currency, fx) })),
			})),
			threshold: thresholds[cloud],
			compared,
			flagged,
		});
		for (const i of r.lineItems) {
			allItems.push({
				cloud,
				label: i.label,
				amount: i.amount,
				currency: r.currency,
				amountEur: toEur(i.amount, r.currency, fx),
				basis: r.lineItemBasis,
			});
		}
	}

	const ok = rows.filter((x) => x.status === "ok");
	const inLast7 = ok.filter((x) => x.last7Eur !== null);
	const inBoth = inLast7.filter((x) => x.prior7Eur !== null);
	const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
	const last7Eur = sum(inLast7.map((x) => x.last7Eur));
	// WoW over the clouds that have BOTH weeks, so a cloud with no prior week cannot read as growth.
	const wowLast = sum(inBoth.map((x) => x.last7Eur));
	const wowPrior = sum(inBoth.map((x) => x.prior7Eur));

	const flags: string[] = [];
	for (const row of rows) {
		if (!row.flagged || !row.compared) continue;
		const basis =
			row.compared.basis === "7d"
				? "last 7 days"
				: row.compared.basis === "est-7d"
					? "estimated 7 days"
					: "7-day equivalent of month to date";
		flags.push(
			`${row.label} spent EUR ${row.compared.eur.toFixed(2)} (${basis}), over its EUR ${row.threshold.toFixed(2)} threshold.`,
		);
	}
	const leaks = args.leakResults.flatMap((l) => (l.status === "ok" ? l.leaks : []));
	if (leaks.length > 0) {
		flags.push(`${leaks.length} resource(s) still carry an e2e handle — see the leak list.`);
	}

	const top = [...allItems]
		.sort((a, b) => (b.amountEur ?? -Infinity) - (a.amountEur ?? -Infinity))
		.slice(0, args.topN ?? 10);

	return {
		window: w,
		rows,
		totals: {
			last7Eur,
			prior7Eur: wowPrior,
			mtdEur: sum(ok.map((x) => x.mtdEur)),
			wow: inBoth.length > 0 ? wowDelta(wowLast, wowPrior) : null,
			excludedFromLast7: rows.filter((x) => x.last7Eur === null).map((x) => x.cloud),
			includesEstimate: inLast7.some((x) => x.estimate),
		},
		top,
		leaks,
		leakScans: args.leakResults.map((l) => ({
			cloud: l.cloud,
			status: l.status,
			detail: l.status === "ok" ? l.scope : l.reason,
		})),
		flags,
		fx: { date: fx.date, missing: [...missingFx] },
		warnings: args.warnings,
	};
}
