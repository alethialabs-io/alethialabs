// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	endOfDay,
	endOfMonth,
	parse,
	startOfDay,
	startOfMonth,
	subDays,
	subMonths,
} from "date-fns";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRESET,
	formatRangeLabel,
	parseRangeInput,
	presetRange,
} from "../src/range";

// A fixed reference instant so every parse is deterministic: 2026-06-16T12:00:00Z.
// Relative-duration assertions use fixed UTC instants (pure subtraction is
// timezone-independent); day-boundary cases derive their expectations with the same
// date-fns helpers so the test holds in any local timezone.
const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("presetRange", () => {
	it("resolves the day presets ending at now", () => {
		const r = presetRange("7d", NOW);
		expect(r.to).toEqual(NOW);
		expect(r.from).toEqual(new Date("2026-06-09T12:00:00.000Z"));
	});

	it("resolves month presets", () => {
		// Derived with date-fns — subMonths preserves local wall-time, so the UTC
		// instant shifts across a DST boundary (a hardcoded instant would be flaky).
		expect(presetRange("3mo", NOW).from).toEqual(subMonths(NOW, 3));
	});

	it("falls back to 7 days for an unknown id (the default preset)", () => {
		expect(presetRange("nope", NOW)).toEqual(presetRange(DEFAULT_PRESET, NOW));
	});
});

describe("parseRangeInput — relative durations", () => {
	it("parses compact units", () => {
		expect(parseRangeInput("10d", NOW)?.from).toEqual(
			new Date("2026-06-06T12:00:00.000Z"),
		);
		expect(parseRangeInput("45m", NOW)?.from).toEqual(
			new Date("2026-06-16T11:15:00.000Z"),
		);
	});

	it("parses spelled-out units with a space", () => {
		expect(parseRangeInput("2 weeks", NOW)?.from).toEqual(
			new Date("2026-06-02T12:00:00.000Z"),
		);
		expect(parseRangeInput("12 hours", NOW)?.from).toEqual(
			new Date("2026-06-16T00:00:00.000Z"),
		);
	});

	it("always ends at now for a relative duration", () => {
		expect(parseRangeInput("2 weeks", NOW)?.to).toEqual(NOW);
	});

	it("rejects zero and non-numeric durations", () => {
		expect(parseRangeInput("0d", NOW)).toBeNull();
		expect(parseRangeInput("abc", NOW)).toBeNull();
	});
});

describe("parseRangeInput — keywords", () => {
	it("today is start-of-day to now", () => {
		const r = parseRangeInput("today", NOW);
		expect(r?.from).toEqual(startOfDay(NOW));
		expect(r?.to).toEqual(NOW);
	});

	it("yesterday is the whole previous day", () => {
		const y = subDays(NOW, 1);
		const r = parseRangeInput("yesterday", NOW);
		expect(r?.from).toEqual(startOfDay(y));
		expect(r?.to).toEqual(endOfDay(y));
	});

	it("last month is the previous calendar month", () => {
		const prev = subMonths(NOW, 1);
		const r = parseRangeInput("last month", NOW);
		expect(r?.from).toEqual(startOfMonth(prev));
		expect(r?.to).toEqual(endOfMonth(prev));
	});
});

describe("parseRangeInput — fixed dates", () => {
	it("a single date covers that whole day", () => {
		const jan1 = parse("Jan 1", "MMM d", NOW);
		const r = parseRangeInput("Jan 1", NOW);
		expect(r?.from).toEqual(startOfDay(jan1));
		expect(r?.to).toEqual(endOfDay(jan1));
	});

	it("parses a slash range", () => {
		const r = parseRangeInput("1/1 - 1/2", NOW);
		expect(r?.from).toEqual(startOfDay(parse("1/1", "M/d", NOW)));
		expect(r?.to).toEqual(endOfDay(parse("1/2", "M/d", NOW)));
	});

	it("rolls a year-less future date back a year", () => {
		// "Dec 25" is after June 16 → reads as last December, not this year's.
		expect(parseRangeInput("Dec 25", NOW)?.from.getFullYear()).toBe(2025);
	});

	it("returns null for gibberish", () => {
		expect(parseRangeInput("not a date", NOW)).toBeNull();
	});
});

describe("formatRangeLabel", () => {
	// Explicit UTC zone so the rendered wall-clock is deterministic regardless of the
	// machine's local timezone.
	it("renders a tz-aware range with lowercase meridiem, year dropped in-year", () => {
		const range = {
			from: new Date("2026-05-27T23:00:00.000Z"),
			to: new Date("2026-06-26T09:30:00.000Z"),
		};
		expect(formatRangeLabel(range, "UTC", NOW)).toBe(
			"May 27, 11pm – Jun 26, 9:30am",
		);
	});

	it("keeps the year when the range is outside the current year", () => {
		const range = {
			from: new Date("2025-12-31T10:00:00.000Z"),
			to: new Date("2026-01-01T10:00:00.000Z"),
		};
		const label = formatRangeLabel(range, "UTC", NOW);
		expect(label).toContain("Dec 31, 2025");
		expect(label).toContain("Jan 1, 2026");
	});

	it("collapses a same-day range to a single side", () => {
		const d = new Date("2026-06-16T08:00:00.000Z");
		expect(formatRangeLabel({ from: d, to: d }, "UTC", NOW)).toBe("Jun 16, 8am");
	});

	it("reflects the chosen timezone", () => {
		const range = {
			from: new Date("2026-06-16T00:00:00.000Z"),
			to: new Date("2026-06-16T12:00:00.000Z"),
		};
		// 00:00Z is the previous evening in New York (UTC-4 in June).
		expect(formatRangeLabel(range, "America/New_York", NOW)).toBe(
			"Jun 15, 8pm – Jun 16, 8am",
		);
	});
});
