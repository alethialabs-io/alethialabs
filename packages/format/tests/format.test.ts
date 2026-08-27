// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
	formatBytes,
	formatDate,
	formatDuration,
	formatMinutes,
	formatMoney,
	formatRelative,
} from "../src/index";

describe("formatMinutes", () => {
	// The reported bug, verbatim: the org overview rendered `0.943 / 200 min` because
	// queryJobMinutesByOrg returns unrounded fractional minutes and the readout called
	// .toLocaleString(), which defaults to three fraction digits.
	it("renders the reported 0.943 as `<1 min`, not `0.943`", () => {
		expect(formatMinutes(0.943)).toBe("<1 min");
	});

	it("distinguishes NOTHING RAN from A LITTLE RAN", () => {
		// These must differ. Rounding 0.4 to `0 min` was the other half of the bug: it made a
		// job that ran look like a job that never did.
		expect(formatMinutes(0)).toBe("0 min");
		expect(formatMinutes(0.4)).toBe("<1 min");
		expect(formatMinutes(0)).not.toBe(formatMinutes(0.4));
	});

	it("rounds to whole minutes below an hour", () => {
		expect(formatMinutes(1)).toBe("1 min");
		expect(formatMinutes(3.2)).toBe("3 min");
		expect(formatMinutes(3.6)).toBe("4 min");
		expect(formatMinutes(59)).toBe("59 min");
	});

	// The boundary the "round once, before the hour test" rule exists for. 59.6 rounds to 60,
	// and 60 minutes IS an hour — so `1h` is right and `59 min` would be a lie. Rounding inside
	// each branch instead would let the same value print `1h 0m` here and `60 min` elsewhere.
	it("rounds once, so a value cannot land on both sides of the hour", () => {
		expect(formatMinutes(59.4)).toBe("59 min");
		expect(formatMinutes(59.6)).toBe("1h");
		expect(formatMinutes(60)).toBe("1h");
	});

	it("drops a zero remainder rather than printing `1h 0m`", () => {
		expect(formatMinutes(60)).toBe("1h");
		expect(formatMinutes(120)).toBe("2h");
		expect(formatMinutes(135)).toBe("2h 15m");
		expect(formatMinutes(1500)).toBe("25h");
	});

	it("clamps nonsense instead of rendering it", () => {
		expect(formatMinutes(-5)).toBe("0 min");
		expect(formatMinutes(Number.NaN)).toBe("0 min");
		expect(formatMinutes(Number.POSITIVE_INFINITY)).toBe("0 min");
	});
});

describe("formatDuration", () => {
	it("matches the implementation it replaces", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatDuration(59_999)).toBe("59s");
		expect(formatDuration(60_000)).toBe("1m 0s");
	});

	it("clamps nonsense", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(-1)).toBe("0s");
		expect(formatDuration(Number.NaN)).toBe("0s");
	});
});

describe("formatDate", () => {
	const iso = "2026-08-27T14:05:00.000Z";

	it("renders each style", () => {
		expect(formatDate(iso)).toBe("27 Aug 2026");
		expect(formatDate(iso, "month")).toBe("August 2026");
		expect(formatDate(iso, "datetime")).toMatch(/^27 Aug 2026, \d{2}:\d{2}$/);
	});

	it("accepts every input shape the call sites use", () => {
		expect(formatDate(new Date(iso))).toBe("27 Aug 2026");
		expect(formatDate(Date.parse(iso))).toBe("27 Aug 2026");
	});

	// A table cell showing "Invalid Date" is worse than an obvious blank.
	it("returns an em dash rather than Invalid Date", () => {
		for (const bad of [null, undefined, "", "not-a-date"]) {
			expect(formatDate(bad)).toBe("—");
		}
	});
});

describe("formatRelative", () => {
	const now = new Date("2026-08-27T12:00:00.000Z");

	it("reads in both directions from an injected baseline", () => {
		expect(formatRelative("2026-08-27T11:57:00.000Z", now)).toBe("3 minutes ago");
		expect(formatRelative("2026-08-27T12:03:00.000Z", now)).toBe("in 3 minutes");
	});

	it("returns an em dash for unparseable input", () => {
		expect(formatRelative(null, now)).toBe("—");
		expect(formatRelative("nope", now)).toBe("—");
	});

	// Guards the signature rather than the wording: without an explicit baseline this would be
	// untestable except by faking the global clock, which is what the old call sites did.
	it("falls back to the real clock when no baseline is given", () => {
		expect(formatRelative(new Date())).toMatch(/ago|in /);
	});
});

describe("formatBytes", () => {
	it("steps by 1024 and keeps one decimal only above bytes", () => {
		expect(formatBytes(812)).toBe("812 B");
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1_500_000)).toBe("1.4 MB");
	});

	it("stops at the largest unit it knows", () => {
		expect(formatBytes(1024 ** 5)).toBe("1 PB");
		expect(formatBytes(1024 ** 6)).toBe("1024 PB");
	});

	it("clamps nonsense", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});
});

describe("formatMoney", () => {
	// The signature says cents because every bug here starts with 12.5 passed for 1250.
	it("treats its input as MINOR units", () => {
		expect(formatMoney(1250)).toBe("$12.50");
		expect(formatMoney(0)).toBe("$0.00");
		expect(formatMoney(99)).toBe("$0.99");
	});

	it("honours a currency", () => {
		expect(formatMoney(1250, "EUR")).toBe("€12.50");
	});

	it("does not render NaN into a billing table", () => {
		expect(formatMoney(Number.NaN)).toBe("$0.00");
	});
});
