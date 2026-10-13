// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit cover for the retention health view's handling of `reconcile-task` entries (#5776).
//
// #5770 registered the Elench drafts windows under a new mechanism, `reconcile-task`. The health view
// knew only `gc-function`, so it reported both as an open GAP (their evidence string, as if nothing
// enforced them), with no window and no measurement — a sweep that had stopped would have gone
// unseen, and a working one read as a hole in the register.
//
// The database is replaced at the `AgeQuery` seam: each query is rendered to its SQL text and answered with the
// age the test assigns to it. That proves which predicate and column each entry is measured on, and
// how the answer is judged. It does NOT prove the SQL runs; the queries are fixed text over columns
// that tests/integration/elench-drafts-sweep.test.ts exercises against real Postgres.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";
import {
	type AgeQuery,
	type RetentionHealthRow,
	measureRetention,
	retentionBreaches,
} from "@/lib/retention/health";

const dialect = new PgDialect();

/**
 * An age query that answers every query with the age `ageFor` returns for its SQL text, and records
 * that text. `retentionHealth` runs the same queries through the database's `execute`.
 */
function fakeAge(ageFor: (text: string) => number | null): { age: AgeQuery; queries: string[] } {
	const queries: string[] = [];
	const age = async (query: SQL): Promise<number | null> => {
		const text = dialect.sqlToQuery(query).sql;
		queries.push(text);
		return ageFor(text);
	};
	return { age, queries };
}

/** The age the drafts queries are answered with, by which window the query measures. */
function draftsAges(active: number | null, discarded: number | null) {
	return (text: string): number | null => {
		if (text.includes("status = 'active'")) return active;
		if (text.includes("status = 'discarded'")) return discarded;
		return null;
	};
}

/** The one row for `id`, failing the test when it is missing. */
function row(rows: RetentionHealthRow[], id: string): RetentionHealthRow {
	const found = rows.find((r) => r.id === id);
	if (!found) throw new Error(`no health row for ${id}`);
	return found;
}

describe("measureRetention — reconcile-task entries", () => {
	it("reports the Elench drafts windows as enforced, not as a gap", async () => {
		const { age } = fakeAge(draftsAges(null, null));
		const rows = await measureRetention(age);
		const windows: [string, number][] = [
			["elench-drafts", RETENTION_DEFAULT_DAYS.elenchDrafts],
			["elench-drafts-discarded", RETENTION_DEFAULT_DAYS.elenchDraftsDiscarded],
		];
		for (const [id, days] of windows) {
			const r = row(rows, id);
			expect(r.mechanism).toBe("reconcile-task");
			expect(r.gap).toBeNull();
			expect(r.effectiveWindowDays).toBe(days);
			expect(r.publishedWindowDays).toBe(days);
		}
	});

	it("measures each window on the column and status the sweep deletes by", async () => {
		const { age, queries } = fakeAge(draftsAges(null, null));
		await measureRetention(age);
		const drafts = queries.filter((q) => q.includes("elench_drafts"));
		expect(drafts).toHaveLength(2);
		const active = drafts.find((q) => q.includes("status = 'active'"));
		const discarded = drafts.find((q) => q.includes("status = 'discarded'"));
		expect(active).toContain("min(updated_at)");
		expect(discarded).toContain("min(discarded_at)");
		// A `sending` row is never deleted by the sweep, so it is measured by neither query.
		expect(drafts.some((q) => q.includes("sending"))).toBe(false);
	});

	it("flags a sweep that has stopped, and by how much", async () => {
		const { age } = fakeAge(draftsAges(40.5, 9.2));
		const rows = await measureRetention(age);
		const active = row(rows, "elench-drafts");
		expect(active.oldestRowAgeDays).toBe(40);
		expect(active.overdue).toBe(true);
		expect(active.overdueByDays).toBe(10);
		const discarded = row(rows, "elench-drafts-discarded");
		expect(discarded.overdue).toBe(true);
		expect(discarded.overdueByDays).toBe(8);
		expect(retentionBreaches(rows).map((r) => r.id).sort()).toEqual([
			"elench-drafts",
			"elench-drafts-discarded",
		]);
	});

	// The sweep runs daily, so a discarded draft can legitimately be close to two days old — the
	// register says so. That must not read as a breach, or the signal stops being read.
	it("allows the daily cadence before calling a window overdue", async () => {
		const healthy = await measureRetention(fakeAge(draftsAges(31.5, 2.5)).age);
		expect(row(healthy, "elench-drafts").overdue).toBe(false);
		expect(row(healthy, "elench-drafts-discarded").overdue).toBe(false);

		const behind = await measureRetention(fakeAge(draftsAges(32.5, 3.1)).age);
		expect(row(behind, "elench-drafts").overdue).toBe(true);
		expect(row(behind, "elench-drafts-discarded").overdue).toBe(true);
	});

	it("reports an unreadable table as unmeasured instead of failing the report", async () => {
		const rows = await measureRetention(async () => {
			throw new Error("relation does not exist");
		});
		const r = row(rows, "elench-drafts");
		expect(r.oldestRowAgeDays).toBeNull();
		expect(r.overdue).toBe(false);
		expect(r.gap).toBeNull();
	});

	it("still reports a provider-held window as a gap", async () => {
		const rows = await measureRetention(fakeAge(() => null).age);
		const r = row(rows, "product-analytics");
		expect(r.gap).toMatch(/NOT ESTABLISHED/);
		expect(r.effectiveWindowDays).toBeNull();
	});
});
