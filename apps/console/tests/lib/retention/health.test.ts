// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit cover for the retention health view's handling of `reconcile-task` entries (#5776).
//
// #5770 registered the Elench drafts windows under a new mechanism, `reconcile-task`. The health view
// knew only `gc-function`, so it reported both as an open GAP (their evidence string, as if nothing
// enforced them), with no window and no measurement — a sweep that had stopped would have gone
// unseen, and a working one read as a hole in the register.
//
// The database is faked at `execute`: each query is rendered to its SQL text and answered with the
// age the test assigns to it. That proves which predicate and column each entry is measured on, and
// how the answer is judged. It does NOT prove the SQL runs; the queries are fixed text over columns
// that tests/integration/elench-drafts-sweep.test.ts exercises against real Postgres.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";
import {
	type RetentionHealthRow,
	retentionBreaches,
	retentionHealth,
} from "@/lib/retention/health";

const dialect = new PgDialect();

/**
 * A `Db` whose `execute` answers every query with the age `ageFor` returns for its SQL text, and
 * records that text. Only `execute` is implemented: it is the one call the health view makes.
 */
function fakeDb(ageFor: (text: string) => number | null): { db: Db; queries: string[] } {
	const queries: string[] = [];
	const fake = {
		execute: async (query: SQL) => {
			const text = dialect.sqlToQuery(query).sql;
			queries.push(text);
			return [{ age_days: ageFor(text) }];
		},
	};
	return { db: fake as never, queries };
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

describe("retentionHealth — reconcile-task entries", () => {
	it("reports the Elench drafts windows as enforced, not as a gap", async () => {
		const { db } = fakeDb(draftsAges(null, null));
		const rows = await retentionHealth(db);
		for (const [id, days] of [
			["elench-drafts", RETENTION_DEFAULT_DAYS.elenchDrafts],
			["elench-drafts-discarded", RETENTION_DEFAULT_DAYS.elenchDraftsDiscarded],
		] as const) {
			const r = row(rows, id);
			expect(r.mechanism).toBe("reconcile-task");
			expect(r.gap).toBeNull();
			expect(r.effectiveWindowDays).toBe(days);
			expect(r.publishedWindowDays).toBe(days);
		}
	});

	it("measures each window on the column and status the sweep deletes by", async () => {
		const { db, queries } = fakeDb(draftsAges(null, null));
		await retentionHealth(db);
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
		const { db } = fakeDb(draftsAges(40.5, 9.2));
		const rows = await retentionHealth(db);
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
		const healthy = await retentionHealth(fakeDb(draftsAges(31.5, 2.5)).db);
		expect(row(healthy, "elench-drafts").overdue).toBe(false);
		expect(row(healthy, "elench-drafts-discarded").overdue).toBe(false);

		const behind = await retentionHealth(fakeDb(draftsAges(32.5, 3.1)).db);
		expect(row(behind, "elench-drafts").overdue).toBe(true);
		expect(row(behind, "elench-drafts-discarded").overdue).toBe(true);
	});

	it("reports an unreadable table as unmeasured instead of failing the report", async () => {
		const fake = {
			execute: async () => {
				throw new Error("relation does not exist");
			},
		};
		const rows = await retentionHealth(fake as never);
		const r = row(rows, "elench-drafts");
		expect(r.oldestRowAgeDays).toBeNull();
		expect(r.overdue).toBe(false);
		expect(r.gap).toBeNull();
	});

	it("still reports a provider-held window as a gap", async () => {
		const rows = await retentionHealth(fakeDb(() => null).db);
		const r = row(rows, "product-analytics");
		expect(r.gap).toMatch(/NOT ESTABLISHED/);
		expect(r.effectiveWindowDays).toBeNull();
	});
});
