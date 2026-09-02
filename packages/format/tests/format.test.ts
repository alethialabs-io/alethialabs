// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
	formatBytes,
	formatDate,
	formatDuration,
	formatMinutes,
	formatQuota,
	formatMoney,
	formatMonthlyRate,
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

describe("formatQuota", () => {
	// This exists because formatMinutes alone did not make the call sites agree — and they
	// immediately did not. Two independent migrations produced `<1 min / 200 min` and
	// `12 min / 3h 20m` from the same helper, which is the original bug one layer up.
	it("humanises the USED side and leaves the allowance recognisable", () => {
		expect(formatQuota(0.943, 200)).toBe("<1 min / 200 min");
		expect(formatQuota(12, 200)).toBe("12 min / 200 min");
		expect(formatQuota(135, 200)).toBe("2h 15m / 200 min");
	});

	// 200 is the number the plan and the pricing page quote. `3h 20m` is arithmetically the
	// same and unrecognisable to someone checking whether they are near their limit.
	it("never converts the allowance to hours", () => {
		expect(formatQuota(1, 200)).not.toContain("3h");
		expect(formatQuota(1, 20_000)).toBe("1 min / 20,000 min");
	});

	it("survives the states a fresh org and a broken row actually produce", () => {
		expect(formatQuota(0, 200)).toBe("0 min / 200 min");
		expect(formatQuota(0, 0)).toBe("0 min / 0 min");
		expect(formatQuota(Number.NaN, 200)).toBe("0 min / 200 min");
		expect(formatQuota(5, Number.NaN)).toBe("5 min / 0 min");
	});

	it("renders over-quota rather than clamping — the overage is the point", () => {
		expect(formatQuota(250, 200)).toBe("4h 10m / 200 min");
	});
});

describe("formatDuration", () => {
	// RENAMED from "matches the implementation it replaces", which is now false and was the whole
	// point: it no longer matches. The console's shape is the one that lost.
	it("reads seconds, then minutes, then rolls into hours", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatDuration(59_999)).toBe("59s");
		// The ruling, asserted in THIS package. Without these the hour behaviour is covered only by
		// the console app's test tree, so packages/format could be changed without its own suite
		// noticing — which is the wrong way round for the package that owns the rule.
		expect(formatDuration(3_599_999)).toBe("59m 59s");
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(7_200_000)).toBe("2h 0m");
		expect(formatDuration(7_505_000)).toBe("2h 5m");
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
		expect(formatDate(iso, "time")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	// The log gutter's shape: seconds, no date, and 24-hour. Pinned to a zone because the whole
	// point of the assertion is the DIGITS, and without one they follow whoever runs the suite.
	it("renders `time` as a 24-hour log timestamp", () => {
		expect(formatDate(iso, "time", "UTC")).toBe("14:05:00");
		// `hourCycle: "h23"` rather than `hour12: false`, which renders midnight as 24:00:00 in
		// some locales. This is the case that distinguishes them.
		expect(formatDate("2026-08-27T00:04:09.000Z", "time", "UTC")).toBe("00:04:09");
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

describe("formatMonthlyRate", () => {
	// The unit split is the whole reason this is a second function. Same money, both spellings.
	it("takes MAJOR units, where formatMoney takes minor", () => {
		expect(formatMonthlyRate(12.5)).toBe("$12.50/mo");
		expect(formatMoney(1250)).toBe("$12.50");
	});

	// THE REGRESSION TEST. The first cut dropped cents above $100, which broke the one property a
	// cost breakdown must have: the lines add up to the total printed under them. These are the
	// real numbers from plan-tab's cost result.
	it("keeps a breakdown's lines summing to its own total, at every magnitude", () => {
		const lines = [60.25, 45.1];
		expect(lines.map((n) => formatMonthlyRate(n, "exact"))).toEqual(["$60.25/mo", "$45.10/mo"]);
		expect(formatMonthlyRate(105.35, "exact")).toBe("$105.35/mo");
	});

	// Two canvas node cards side by side rendered the same field at two precisions. There is no
	// magnitude at which the precision may change, in EITHER register.
	it("never changes precision with magnitude", () => {
		expect(formatMonthlyRate(99.99)).toBe("$99.99/mo");
		expect(formatMonthlyRate(100)).toBe("$100.00/mo");
		expect(formatMonthlyRate(1240.37)).toBe("$1,240.37/mo");
		expect(formatMonthlyRate(99.99, "exact")).toBe("$99.99/mo");
		expect(formatMonthlyRate(100, "exact")).toBe("$100.00/mo");
		expect(formatMonthlyRate(1240.37, "exact")).toBe("$1,240.37/mo");
	});

	// The Cost tab lists one row per Terraform address, and sub-$1 cloud line items (hosted zones,
	// buckets, small volumes) are the common case. Five `<$1/mo` rows over a `$2.00/mo` total is a
	// breakdown that cannot be reconciled at all.
	it("does not collapse a sub-unit LINE ITEM, which the reader is adding up", () => {
		expect(formatMonthlyRate(0.5, "exact")).toBe("$0.50/mo");
		expect(formatMonthlyRate(0.03, "exact")).toBe("$0.03/mo");
		expect(formatMonthlyRate(0.4, "exact")).toBe("$0.40/mo");
	});

	// The boundary where the two registers would disagree if the value were rounded inside each
	// branch instead of once, before them.
	it("rounds to cents ONCE, before the sub-unit test", () => {
		expect(formatMonthlyRate(0.999)).toBe("$1.00/mo");
		expect(formatMonthlyRate(0.999, "exact")).toBe("$1.00/mo");
	});

	// `$0.02/mo` for a WHOLE PROJECT reads as a broken number, not a cheap one; `<$1/mo` is the
	// same admission formatMinutes makes with `<1 min`. That argument is about a lone headline.
	it("admits a sub-unit ESTIMATE rather than printing a figure it cannot stand behind", () => {
		expect(formatMonthlyRate(0.023)).toBe("<$1/mo");
		// Rounds to zero cents but is NOT zero — "nothing is running" would be a lie.
		expect(formatMonthlyRate(0.001)).toBe("<$1/mo");
	});

	// Nothing provisioned is a real, distinct state, and `$0.00/mo` reads like a bill for nothing
	// — in a headline. In a column of line items a genuine zero has to align with its neighbours.
	it("distinguishes NOTHING from A LITTLE, and only in the headline register", () => {
		expect(formatMonthlyRate(0)).toBe("$0/mo");
		expect(formatMonthlyRate(Number.NaN)).toBe("$0/mo");
		expect(formatMonthlyRate(Number.POSITIVE_INFINITY)).toBe("$0/mo");
		expect(formatMonthlyRate(0, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(Number.NaN, "exact")).toBe("$0.00/mo");
	});

	// This case is NOT a protection — it is the opposite, and it is split out from the zero case
	// above so that nobody reads a clamped negative as "nothing provisioned". `<= 0` is ONE test,
	// so a saving renders exactly as zero does in BOTH registers, including the one that promises
	// to round nothing away: a column holding a credit will not sum to its own total. There is no
	// credit register in this package or in `packages/core/format`, and `"exact"` is not one —
	// rendering a delta or a saving needs a new function, not a new caller. Pinned here so the
	// gap cannot be closed, or widened, without a reader seeing it.
	it("LOSES THE SIGN: a negative clamps to zero in both registers, so a saving reads as nothing", () => {
		expect(formatMonthlyRate(-1)).toBe("$0/mo");
		expect(formatMonthlyRate(-1, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(-1240.37, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(-12.5, "exact", "EUR")).toBe("€0.00/mo");
		expect(formatMonthlyRate(Number.NEGATIVE_INFINITY, "exact")).toBe("$0.00/mo");
	});

	// The runner fleet prices in euros. One symbol decision, shared with formatMoney.
	it("honours a currency in every branch of both registers", () => {
		expect(formatMonthlyRate(12.5, "estimate", "EUR")).toBe("€12.50/mo");
		expect(formatMonthlyRate(0, "estimate", "EUR")).toBe("€0/mo");
		expect(formatMonthlyRate(0.4, "estimate", "EUR")).toBe("<€1/mo");
		expect(formatMonthlyRate(1240, "estimate", "EUR")).toBe("€1,240.00/mo");
		expect(formatMonthlyRate(0.4, "exact", "EUR")).toBe("€0.40/mo");
		expect(formatMonthlyRate(0, "exact", "EUR")).toBe("€0.00/mo");
	});
});
