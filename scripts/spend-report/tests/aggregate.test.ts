// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { bucketDaily, buildReport, DEFAULT_THRESHOLDS, parseThresholds, prorateMtdToWeek, wowDelta } from "../src/aggregate";
import { normaliseDay, reportWindow } from "../src/dates";
import type { CloudReading } from "../src/types";

// Monday 2026-11-16 07:00 UTC — the cron's own instant.
const MONDAY = new Date("2026-11-16T07:00:00Z");

describe("reportWindow", () => {
	it("covers the seven complete days before today, and the seven before those", () => {
		const w = reportWindow(MONDAY);
		expect(w).toMatchObject({
			today: "2026-11-16",
			last7Start: "2026-11-09",
			prior7Start: "2026-11-02",
			monthStart: "2026-11-01",
			queryStart: "2026-11-01",
			weekEnding: "2026-11-15",
			daysElapsedInMonth: 15,
			billingMonth: "2026-11",
		});
	});

	it("reaches back into the previous month when the prior week starts there", () => {
		const w = reportWindow(new Date("2026-11-03T07:00:00Z"));
		expect(w.prior7Start).toBe("2026-10-20");
		expect(w.queryStart).toBe("2026-10-20");
		expect(w.monthStart).toBe("2026-11-01");
	});

	it("has no complete month-to-date day on the 1st", () => {
		expect(reportWindow(new Date("2026-12-01T07:00:00Z")).daysElapsedInMonth).toBe(0);
	});
});

describe("normaliseDay", () => {
	it("reads every provider's day stamp", () => {
		expect(normaliseDay(20261109)).toBe("2026-11-09");
		expect(normaliseDay("2026-11-09T00:00:00Z")).toBe("2026-11-09");
		expect(normaliseDay("2026-11-09")).toBe("2026-11-09");
		expect(normaliseDay("Nov 9")).toBeNull();
	});
});

describe("bucketDaily", () => {
	const w = reportWindow(MONDAY);
	it("puts each day in exactly the window it belongs to", () => {
		const b = bucketDaily(
			[
				{ date: "2026-11-01", key: "EC2", amount: 1 }, // mtd only (before prior7)
				{ date: "2026-11-02", key: "EC2", amount: 2 }, // prior7 + mtd
				{ date: "2026-11-08", key: "EC2", amount: 3 }, // prior7 + mtd (last day of prior)
				{ date: "2026-11-09", key: "EC2", amount: 4 }, // last7 + mtd (first day of last)
				{ date: "2026-11-15", key: "S3", amount: 5 }, // last7 + mtd (yesterday)
				{ date: "2026-11-16", key: "EC2", amount: 100 }, // today — partial, excluded everywhere
				{ date: "2026-10-31", key: "EC2", amount: 100 }, // outside every window
			],
			w,
		);
		expect(b.last7).toBe(9);
		expect(b.prior7).toBe(5);
		expect(b.mtd).toBe(15);
		expect(b.byKeyLast7).toEqual([
			{ label: "S3", amount: 5 },
			{ label: "EC2", amount: 4 },
		]);
	});

	it("reports MTD as unknown on the 1st rather than as zero", () => {
		expect(bucketDaily([], reportWindow(new Date("2026-12-01T07:00:00Z"))).mtd).toBeNull();
	});
});

describe("wowDelta", () => {
	it("computes the change and the percentage", () => {
		expect(wowDelta(12, 10)).toEqual({ abs: 2, pct: 20 });
		expect(wowDelta(5, 10)).toEqual({ abs: -5, pct: -50 });
	});
	it("has no percentage against a zero week, and nothing against an unknown one", () => {
		expect(wowDelta(3, 0)).toEqual({ abs: 3, pct: null });
		expect(wowDelta(3, null)).toBeNull();
		expect(wowDelta(null, 3)).toBeNull();
	});
});

describe("parseThresholds", () => {
	it("uses the defaults when unset", () => {
		expect(parseThresholds(undefined)).toEqual({ thresholds: DEFAULT_THRESHOLDS, warnings: [] });
	});
	it("overrides only the clouds it names", () => {
		const t = parseThresholds('{"aws": 80, "gcp": 5}');
		expect(t.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, aws: 80, gcp: 5 });
		expect(t.warnings).toEqual([]);
	});
	it("says so, rather than flagging nothing, when the value is wrong", () => {
		expect(parseThresholds("{aws:").warnings[0]).toMatch(/not valid JSON/);
		expect(parseThresholds("[1]").warnings[0]).toMatch(/JSON object/);
		const bad = parseThresholds('{"vercel": 1, "aws": -1}');
		expect(bad.thresholds).toEqual(DEFAULT_THRESHOLDS);
		expect(bad.warnings).toHaveLength(2);
	});
});

describe("prorateMtdToWeek", () => {
	it("scales month to date to seven days", () => {
		expect(prorateMtdToWeek(30, 15)).toBe(14);
		expect(prorateMtdToWeek(30, 0)).toBeNull();
	});
});

/** A readable cloud with sensible defaults. */
function reading(over: Partial<CloudReading> & Pick<CloudReading, "cloud">): CloudReading {
	return {
		status: "ok",
		currency: "EUR",
		last7: null,
		prior7: null,
		mtd: null,
		estimate: false,
		lineItemBasis: "7d",
		lineItems: [],
		breakdowns: [],
		notes: [],
		...over,
	};
}

describe("buildReport", () => {
	const w = reportWindow(MONDAY);
	const fx = { date: "2026-11-13", rates: { EUR: 1, USD: 1.25 } };

	const rep = buildReport({
		window: w,
		fx,
		thresholds: { ...DEFAULT_THRESHOLDS, aws: 30, hetzner: 5 },
		warnings: [],
		results: [
			reading({ cloud: "aws", currency: "USD", last7: 50, prior7: 25, mtd: 100, lineItems: [{ label: "EKS", amount: 40 }, { label: "S3", amount: 10 }] }),
			{ cloud: "azure", status: "unreadable", reason: "SPEND_AZURE_CLIENT_ID is unset" },
			reading({ cloud: "gcp", currency: "USD", mtd: 15, lineItemBasis: "mtd", lineItems: [{ label: "budget (month to date)", amount: 15 }] }),
			reading({ cloud: "hetzner", last7: 6, estimate: true, lineItemBasis: "est-7d", lineItems: [{ label: "server box", amount: 6 }] }),
		],
		leakResults: [
			{ cloud: "aws", status: "ok", scope: "us-east-1", leaks: [{ cloud: "aws", id: "arn:aws:ec2:us-east-1:1:vpc/vpc-1", kind: "ec2:vpc", handle: "e2e-1-1", key: "project-id" }] },
			{ cloud: "hetzner", status: "unreadable", reason: "HCLOUD_TOKEN (repo secret) is unset" },
		],
	});

	it("converts to EUR and totals only the clouds with a 7-day figure", () => {
		const aws = rep.rows.find((r) => r.cloud === "aws");
		expect(aws?.last7Eur).toBe(40);
		expect(aws?.prior7Eur).toBe(20);
		expect(rep.totals.last7Eur).toBe(46); // 40 AWS + 6 Hetzner
		expect(rep.totals.excludedFromLast7).toEqual(["azure", "gcp"]);
		expect(rep.totals.includesEstimate).toBe(true);
	});

	it("computes WoW only over clouds that have both weeks", () => {
		// Hetzner has no prior week, so it is left out of the comparison instead of reading as growth.
		expect(rep.totals.wow).toEqual({ abs: 20, pct: 100 });
	});

	it("keeps an unreadable cloud as a row with its reason", () => {
		const az = rep.rows.find((r) => r.cloud === "azure");
		expect(az).toMatchObject({ status: "unreadable", reason: "SPEND_AZURE_CLIENT_ID is unset", flagged: false });
	});

	it("flags each cloud over its threshold, on the basis it was compared on", () => {
		expect(rep.flags).toEqual([
			"AWS spent EUR 40.00 (last 7 days), over its EUR 30.00 threshold.",
			"Hetzner spent EUR 6.00 (estimated 7 days), over its EUR 5.00 threshold.",
			"1 resource(s) still carry an e2e handle — see the leak list.",
		]);
		// GCP's MTD of USD 15 → EUR 12 over 15 days → EUR 5.60/7d: under its 15.
		const gcp = rep.rows.find((r) => r.cloud === "gcp");
		expect(gcp?.compared).toEqual({ eur: 5.6, basis: "mtd-prorated" });
		expect(gcp?.flagged).toBe(false);
	});

	it("ranks line items across clouds by EUR, with each one's basis", () => {
		expect(rep.top.map((t) => [t.cloud, t.label, t.amountEur, t.basis])).toEqual([
			["aws", "EKS", 32, "7d"],
			["gcp", "budget (month to date)", 12, "mtd"],
			["aws", "S3", 8, "7d"],
			["hetzner", "server box", 6, "est-7d"],
		]);
	});

	it("carries the leak list and what was not scanned", () => {
		expect(rep.leaks).toHaveLength(1);
		expect(rep.leakScans).toEqual([
			{ cloud: "aws", status: "ok", detail: "us-east-1" },
			{ cloud: "hetzner", status: "unreadable", detail: "HCLOUD_TOKEN (repo secret) is unset" },
		]);
	});

	it("names a currency it could not convert instead of dropping it silently", () => {
		const r = buildReport({
			window: w,
			fx: { date: null, rates: { EUR: 1 } },
			thresholds: DEFAULT_THRESHOLDS,
			warnings: [],
			results: [reading({ cloud: "aws", currency: "USD", last7: 10, prior7: 5 })],
			leakResults: [],
		});
		expect(r.fx.missing).toEqual(["USD"]);
		expect(r.rows[0]?.last7Eur).toBeNull();
		expect(r.totals.excludedFromLast7).toEqual(["aws"]);
		expect(r.totals.wow).toBeNull();
	});
});
