// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The Postgres-derived funnel (REL-L12, #6913), unit half: the window arithmetic, the shaping of
// aggregate rows into the report, and the property the unit exists for — THE REPORT CARRIES NO
// IDENTIFIER. The SQL itself is measured against real Postgres in tests/integration/funnel.test.ts.
//
// The no-identifier assertion is made on a result produced from rows that DO carry identifiers
// (an org id, a user id, an email): a fixture of clean rows would pass whether or not the shaping
// strips anything. And it is made two ways — the set of keys anywhere in the report is exactly the
// aggregate vocabulary, and no string value anywhere looks like a uuid or an email — because a
// leaked identifier can arrive as a new key or inside an existing one.

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn<(q: unknown) => Promise<unknown[]>>();
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({ execute }) }));

import { getServiceDb } from "@/lib/db";
import {
	FUNNEL_MAX_DAYS,
	FUNNEL_STAGES,
	funnelReportSchema,
	funnelWindow,
	queryFunnel,
	shapeFunnel,
} from "@/lib/queries/funnel";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Every key the report may contain, at any depth. */
const AGGREGATE_KEYS = new Set(["from", "to", "days", "cells", "totals", "day", "stage", "cloud", "count"]);

/** Every object key and every string value anywhere inside `value`. */
function walk(value: unknown, keys: Set<string>, strings: string[]): void {
	if (typeof value === "string") strings.push(value);
	else if (Array.isArray(value)) for (const v of value) walk(v, keys, strings);
	else if (typeof value === "object" && value !== null) {
		for (const [k, v] of Object.entries(value)) {
			keys.add(k);
			walk(v, keys, strings);
		}
	}
}

/** Asserts `report` holds aggregate vocabulary only: no foreign key, no uuid or email value. */
function expectNoIdentifier(report: unknown): void {
	const keys = new Set<string>();
	const strings: string[] = [];
	walk(report, keys, strings);
	expect([...keys].filter((k) => !AGGREGATE_KEYS.has(k))).toEqual([]);
	expect(strings.filter((s) => UUID.test(s) || EMAIL.test(s))).toEqual([]);
}

const ORG_A = "6f1c2a7e-0b5d-4c8e-9a3f-1d2e3f4a5b6c";
const ORG_B = "0a9b8c7d-6e5f-4a3b-8c1d-0e9f8a7b6c5d";

/** Aggregate rows that also carry identifier columns, as a careless query would return them. */
function leakyRows(): unknown[] {
	return [
		{ stage: "signed_up", cloud: null, day: "2026-11-20", count: 3, user_id: ORG_A, email: "a@example.com" },
		{ stage: "cloud_connected", cloud: "aws", day: "2026-11-20", count: "2", org_id: ORG_A },
		{ stage: "cloud_connected", cloud: "gcp", day: "2026-11-21", count: 1, org_id: ORG_B, name: "Acme" },
		{ stage: "first_deploy", cloud: "aws", day: "2026-11-21", count: 1, project_id: ORG_B },
		{ stage: "subscribed", cloud: null, day: "2026-11-21", count: 1, organization_id: ORG_A },
	];
}

describe("funnelWindow", () => {
	it("covers the last N UTC days ending with today, as a half-open instant range", () => {
		const w = funnelWindow(new Date("2026-11-21T23:59:00Z"), 3);
		expect(w.days).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
		expect(w.start.toISOString()).toBe("2026-11-19T00:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-11-22T00:00:00.000Z");
	});

	it("answers a different window for a different length and day (not a fixed fixture)", () => {
		const w = funnelWindow(new Date("2027-01-01T00:00:00Z"), 2);
		expect(w.days).toEqual(["2026-12-31", "2027-01-01"]);
	});

	it("clamps the length to 1..90 and floors a fraction", () => {
		const now = new Date("2026-11-21T12:00:00Z");
		expect(funnelWindow(now, 0).days).toHaveLength(1);
		expect(funnelWindow(now, 1000).days).toHaveLength(FUNNEL_MAX_DAYS);
		expect(funnelWindow(now, 7.9).days).toHaveLength(7);
		expect(funnelWindow(now, Number.NaN).days).toHaveLength(30);
	});
});

describe("shapeFunnel", () => {
	const days = ["2026-11-20", "2026-11-21"];

	it("carries no identifier even when the rows it is given do", () => {
		const report = shapeFunnel(leakyRows(), days);
		expectNoIdentifier(report);
		// The leaky rows above were not dropped wholesale: their counts survived the stripping.
		expect(report.cells).toHaveLength(5);
	});

	it("counts per day, per stage and per cloud, and totals over the window", () => {
		const report = shapeFunnel(leakyRows(), days);
		expect(report.from).toBe("2026-11-20");
		expect(report.to).toBe("2026-11-21");
		expect(report.days).toEqual(days);
		expect(report.cells).toEqual([
			{ day: "2026-11-20", stage: "signed_up", cloud: null, count: 3 },
			{ day: "2026-11-20", stage: "cloud_connected", cloud: "aws", count: 2 },
			{ day: "2026-11-21", stage: "cloud_connected", cloud: "gcp", count: 1 },
			{ day: "2026-11-21", stage: "first_deploy", cloud: "aws", count: 1 },
			{ day: "2026-11-21", stage: "subscribed", cloud: null, count: 1 },
		]);
		expect(report.totals).toEqual([
			{ stage: "signed_up", cloud: null, count: 3 },
			{ stage: "cloud_connected", cloud: "aws", count: 2 },
			{ stage: "cloud_connected", cloud: "gcp", count: 1 },
			{ stage: "first_deploy", cloud: "aws", count: 1 },
			{ stage: "subscribed", cloud: null, count: 1 },
		]);
	});

	it("sums duplicate cells, and drops zero counts and days outside the window", () => {
		const report = shapeFunnel(
			[
				{ stage: "project_created", cloud: "hetzner", day: "2026-11-21", count: 2 },
				{ stage: "project_created", cloud: "hetzner", day: "2026-11-21", count: 5 },
				{ stage: "project_created", cloud: "azure", day: "2026-11-21", count: 0 },
				{ stage: "project_created", cloud: "hetzner", day: "2026-11-19", count: 9 },
			],
			days,
		);
		expect(report.cells).toEqual([
			{ day: "2026-11-21", stage: "project_created", cloud: "hetzner", count: 7 },
		]);
		expect(report.totals).toEqual([{ stage: "project_created", cloud: "hetzner", count: 7 }]);
	});

	it("refuses a row with a stage or cloud it does not know, rather than passing it on", () => {
		expect(() =>
			shapeFunnel([{ stage: "user_email", cloud: null, day: "2026-11-21", count: 1 }], days),
		).toThrow();
		expect(() =>
			shapeFunnel([{ stage: "signed_up", cloud: "a@example.com", day: "2026-11-21", count: 1 }], days),
		).toThrow();
	});

	it("an empty window is an empty report over every day", () => {
		const report = shapeFunnel([], days);
		expect(report).toEqual({ from: "2026-11-20", to: "2026-11-21", days, cells: [], totals: [] });
	});
});

describe("funnelReportSchema", () => {
	it("is strict: a report with an identifier field added at any level fails to parse", () => {
		const report = shapeFunnel(leakyRows(), ["2026-11-20", "2026-11-21"]);
		expect(funnelReportSchema.safeParse(report).success).toBe(true);
		expect(funnelReportSchema.safeParse({ ...report, orgIds: [ORG_A] }).success).toBe(false);
		const [first, ...rest] = report.cells;
		expect(
			funnelReportSchema.safeParse({ ...report, cells: [{ ...first, orgId: ORG_A }, ...rest] }).success,
		).toBe(false);
		const [t0, ...trest] = report.totals;
		expect(
			funnelReportSchema.safeParse({ ...report, totals: [{ ...t0, email: "a@example.com" }, ...trest] })
				.success,
		).toBe(false);
	});
});

describe("queryFunnel", () => {
	beforeEach(() => execute.mockReset());

	it("runs ONE aggregate statement and shapes its rows into an identifier-free report", async () => {
		execute.mockResolvedValue(leakyRows());
		const report = await queryFunnel(getServiceDb(), {
			now: new Date("2026-11-21T08:00:00Z"),
			days: 2,
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(report.days).toEqual(["2026-11-20", "2026-11-21"]);
		expectNoIdentifier(report);
	});

	it("selects only stage, cloud, day and count, bounded by the window", async () => {
		execute.mockResolvedValue([]);
		await queryFunnel(getServiceDb(), { now: new Date("2026-11-21T08:00:00Z"), days: 7 });
		const fragment = execute.mock.calls[0]?.[0];
		if (!(fragment instanceof SQL)) throw new Error("queryFunnel did not send an SQL fragment");
		const { sql, params } = new PgDialect().sqlToQuery(fragment);
		expect(sql).toMatch(/select\s+e\.stage,\s+e\.cloud,\s+to_char\([^)]*\) as day,\s+count\(\*\)::int as count\s+from events e/);
		expect(params).toContain("2026-11-15T00:00:00.000Z");
		expect(params).toContain("2026-11-22T00:00:00.000Z");
		// Every stage the report names is produced by the statement.
		for (const s of FUNNEL_STAGES) expect(sql).toContain(`'${s}'`);
	});
});
