// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The report's three windows, as `YYYY-MM-DD` UTC dates. Every `end` is EXCLUSIVE — the convention
 * Cost Explorer and the Azure query API both use — and "today" is never inside a window, because
 * today's spend is still arriving.
 *
 *   last7   [today-7,  today)
 *   prior7  [today-14, today-7)
 *   mtd     [first of this month, today)   — EMPTY on the 1st (start === end)
 *
 * `queryStart` is the earliest date any of the three needs, so one daily query covers them all.
 */
export interface ReportWindow {
	today: string;
	last7Start: string;
	prior7Start: string;
	monthStart: string;
	queryStart: string;
	/** The last day the report covers (inclusive): today − 1. */
	weekEnding: string;
	/** Complete days elapsed this month (0 on the 1st). */
	daysElapsedInMonth: number;
	/** `YYYY-MM` of the month MTD refers to. */
	billingMonth: string;
}

/** Formats a Date as its UTC `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** Returns a new Date `days` days after `d` (negative goes back). */
function addDays(d: Date, days: number): Date {
	return new Date(d.getTime() + days * 86_400_000);
}

/** Computes the report windows for a run at instant `now`. */
export function reportWindow(now: Date): ReportWindow {
	const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
	const last7Start = addDays(today, -7);
	const prior7Start = addDays(today, -14);
	const queryStart = monthStart < prior7Start ? monthStart : prior7Start;
	return {
		today: isoDate(today),
		last7Start: isoDate(last7Start),
		prior7Start: isoDate(prior7Start),
		monthStart: isoDate(monthStart),
		queryStart: isoDate(queryStart),
		weekEnding: isoDate(addDays(today, -1)),
		daysElapsedInMonth: today.getUTCDate() - 1,
		billingMonth: isoDate(monthStart).slice(0, 7),
	};
}

/** Normalises a provider's day stamp (`2026-11-09`, `2026-11-09T00:00:00Z`, `20261109`) to `YYYY-MM-DD`. */
export function normaliseDay(value: string | number): string | null {
	const s = String(value).trim();
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
	return m?.[1] ?? null;
}
