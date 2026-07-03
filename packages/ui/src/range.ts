// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The pure core of the time-range filters (components/filters/*): turns a preset id or a
// free-typed string (Vercel-style — "10d", "2 weeks", "yesterday", "Jan 1", "1/1 - 1/2")
// into a concrete `{ from, to }` window, plus a tz-aware display label. No I/O and no
// React, so the filter components are thin shells over this and the parsing is unit-tested
// in isolation. Every function takes an explicit `now` (defaulting to the wall clock) so
// tests are deterministic.

import {
	endOfDay,
	endOfMonth,
	isValid,
	parse,
	startOfDay,
	startOfMonth,
	subDays,
	subHours,
	subMinutes,
	subMonths,
	subWeeks,
	subYears,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

/** A concrete, resolved time window (half-open is fine for our queries: from ≤ t < to). */
export interface DateRange {
	from: Date;
	to: Date;
}

/** A named quick-range shown as a button in the picker. */
export interface RangePreset {
	id: string;
	label: string;
}

/** The relative quick-ranges, in the order they appear in the popover. */
export const RANGE_PRESETS: RangePreset[] = [
	{ id: "7d", label: "Last 7 days" },
	{ id: "14d", label: "Last 14 days" },
	{ id: "30d", label: "Last 30 days" },
	{ id: "3mo", label: "Last 3 months" },
	{ id: "12mo", label: "Last 12 months" },
];

/** The default range the page opens on. */
export const DEFAULT_PRESET = "7d";

/** Resolves a preset id to a window ending at `now`. Unknown ids fall back to 7 days. */
export function presetRange(id: string, now: Date = new Date()): DateRange {
	switch (id) {
		case "14d":
			return { from: subDays(now, 14), to: now };
		case "30d":
			return { from: subDays(now, 30), to: now };
		case "3mo":
			return { from: subMonths(now, 3), to: now };
		case "12mo":
			return { from: subMonths(now, 12), to: now };
		default:
			return { from: subDays(now, 7), to: now };
	}
}

// Relative-duration units → a date-fns `sub*` applied to `now`.
const UNIT_SUBTRACTORS: Record<string, (d: Date, n: number) => Date> = {
	m: subMinutes,
	min: subMinutes,
	mins: subMinutes,
	minute: subMinutes,
	minutes: subMinutes,
	h: subHours,
	hr: subHours,
	hrs: subHours,
	hour: subHours,
	hours: subHours,
	d: subDays,
	day: subDays,
	days: subDays,
	w: subWeeks,
	wk: subWeeks,
	wks: subWeeks,
	week: subWeeks,
	weeks: subWeeks,
	mo: subMonths,
	month: subMonths,
	months: subMonths,
	y: subYears,
	yr: subYears,
	yrs: subYears,
	year: subYears,
	years: subYears,
};

/** "10d", "2 weeks", "45m", "12 hours" → a window of that length ending at `now`. */
function parseRelativeDuration(text: string, now: Date): DateRange | null {
	const m = /^(\d+)\s*([a-z]+)$/.exec(text);
	if (!m) return null;
	const [, numStr, unit] = m;
	const n = Number(numStr);
	const sub = unit ? UNIT_SUBTRACTORS[unit] : undefined;
	if (!sub || !Number.isFinite(n) || n <= 0) return null;
	return { from: sub(now, n), to: now };
}

/** Named relative keywords ("today", "yesterday", "last month", "last week"). */
function parseKeyword(text: string, now: Date): DateRange | null {
	switch (text) {
		case "today":
			return { from: startOfDay(now), to: now };
		case "yesterday": {
			const y = subDays(now, 1);
			return { from: startOfDay(y), to: endOfDay(y) };
		}
		case "last week":
			return { from: subDays(now, 7), to: now };
		case "last month": {
			const prev = subMonths(now, 1);
			return { from: startOfMonth(prev), to: endOfMonth(prev) };
		}
		default:
			return null;
	}
}

// The fixed-date formats we accept, tried in order. Missing fields (e.g. the year in
// "Jan 1") are filled from the reference date by date-fns.
const FIXED_FORMATS = ["MMM d", "MMMM d", "MMM d yyyy", "MMMM d yyyy", "M/d", "M/d/yyyy"];

/** Parses a single fixed date like "Jan 1" or "1/1"; a year-less date in the future
 *  is rolled back a year so "Dec 25" in January reads as last December, not next. */
function parseFixedDate(text: string, now: Date): Date | null {
	for (const fmt of FIXED_FORMATS) {
		const d = parse(text, fmt, now);
		if (isValid(d)) {
			return d > now && !/\d{4}/.test(text) ? subYears(d, 1) : d;
		}
	}
	return null;
}

/**
 * Parses a free-typed range string into a window, or null when it's not understood.
 * Handles, in order: relative durations ("10d", "2 weeks"), keywords ("yesterday"),
 * fixed ranges ("Jan 1 - Jan 5", "1/1 - 1/2"), and a single fixed date (that whole day).
 */
export function parseRangeInput(
	input: string,
	now: Date = new Date(),
): DateRange | null {
	const text = input.trim().toLowerCase();
	if (!text) return null;

	const relative = parseRelativeDuration(text, now);
	if (relative) return relative;

	const keyword = parseKeyword(text, now);
	if (keyword) return keyword;

	// Fixed range: "<a> - <b>" (spaced hyphen avoids splitting "1/1" or "10-d").
	const dashIndex = text.indexOf(" - ");
	if (dashIndex !== -1) {
		const a = parseFixedDate(text.slice(0, dashIndex).trim(), now);
		const b = parseFixedDate(text.slice(dashIndex + 3).trim(), now);
		if (a && b) return { from: startOfDay(a), to: endOfDay(b) };
		return null;
	}

	// Single fixed date → that entire day.
	const single = parseFixedDate(text, now);
	if (single) return { from: startOfDay(single), to: endOfDay(single) };

	return null;
}

// ── Timezone-aware display ─────────────────────────────────────────────────────

/** The browser's IANA timezone (e.g. "Europe/Sofia"), falling back to UTC. */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** The full IANA timezone list, the local zone hoisted to the front. */
export function timeZoneOptions(): string[] {
	const local = localTimeZone();
	let all: string[];
	try {
		all = Intl.supportedValuesOf("timeZone");
	} catch {
		all = [local, "UTC"];
	}
	return [local, ...all.filter((z) => z !== local)];
}

/** A short, lowercase-meridiem time ("11pm", "9:30am") in the given zone. */
function timePart(d: Date, tz: string): string {
	const minutes = formatInTimeZone(d, tz, "m");
	const fmt = minutes === "0" ? "ha" : "h:mma";
	return formatInTimeZone(d, tz, fmt).toLowerCase();
}

/**
 * A compact, tz-aware label for a range, Vercel-style: "May 27, 11pm – Jun 26".
 * Drops the year when both ends fall in the current year, and collapses a same-day
 * range to one side. All comparisons are evaluated in the DISPLAY zone (`tz`), not the
 * machine's local zone, so the rendered wall-clock is correct. Zone defaults to the browser's.
 */
export function formatRangeLabel(
	range: DateRange,
	tz: string = localTimeZone(),
	now: Date = new Date(),
): string {
	const year = (d: Date) => formatInTimeZone(d, tz, "yyyy");
	const day = (d: Date) => formatInTimeZone(d, tz, "yyyy-MM-dd");
	const yearless = year(range.from) === year(now) && year(range.to) === year(now);
	const dateFmt = yearless ? "MMM d" : "MMM d, yyyy";
	const side = (d: Date) =>
		`${formatInTimeZone(d, tz, dateFmt)}, ${timePart(d, tz)}`;
	if (day(range.from) === day(range.to)) return side(range.from);
	return `${side(range.from)} – ${side(range.to)}`;
}
