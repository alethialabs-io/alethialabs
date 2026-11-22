// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_STATEMENTS } from "../src/schema";

/**
 * The schema the Worker applies to itself on every new isolate (src/schema.ts). This is the only
 * place its statements run before production does, so a syntax error or a constraint that does not
 * do what its comment claims surfaces here and not as the cron throwing at the edge.
 */

/** A fresh in-memory database with the schema applied. */
function applied(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	for (const s of SCHEMA_STATEMENTS) db.exec(s);
	return db;
}

/** One value read off a row, as a number. */
function num(row: Record<string, unknown> | undefined, key: string): number {
	const v = row?.[key];
	return typeof v === "number" ? v : Number.NaN;
}

describe("the D1 schema", () => {
	it("applies cleanly", () => {
		expect(() => applied()).not.toThrow();
	});

	/** Applied once per isolate, forever — a second apply must be a no-op. */
	it("is idempotent — every statement is IF NOT EXISTS", () => {
		const db = applied();
		for (const s of SCHEMA_STATEMENTS) {
			expect(s).toMatch(/IF NOT EXISTS/);
			expect(() => db.exec(s)).not.toThrow();
		}
	});

	it("creates the three tables the Worker reads", () => {
		const rows = applied()
			.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
			.all();
		expect(rows.map((r) => r.name)).toEqual(["checks", "daily", "incidents"]);
	});

	describe("incidents_one_open_per_component", () => {
		it("refuses a second OPEN incident for the same component", () => {
			const db = applied();
			const insert = (started: number): unknown =>
				db.prepare("insert into incidents (component, started_at, worst) values (?, ?, 'down')").run("database", started);
			insert(1);
			expect(() => insert(2)).toThrow();
		});

		it("allows a new one once the previous is resolved", () => {
			const db = applied();
			db.prepare("insert into incidents (component, started_at, worst) values ('database', 1, 'down')").run();
			db.prepare("update incidents set resolved_at = 3 where component = 'database'").run();
			expect(() =>
				db.prepare("insert into incidents (component, started_at, worst) values ('database', 4, 'down')").run(),
			).not.toThrow();
		});

		it("does not constrain DIFFERENT components", () => {
			const db = applied();
			for (const c of ["database", "console", "authorization"]) {
				expect(() =>
					db.prepare("insert into incidents (component, started_at, worst) values (?, 1, 'down')").run(c),
				).not.toThrow();
			}
		});
	});

	/**
	 * The exact upsert runCycle issues every minute. `excluded.up` must be the value being inserted,
	 * not the stored one — backwards, the uptime percentage is quietly wrong forever.
	 */
	it("accumulates the daily rollup correctly across cycles", () => {
		const db = applied();
		const upsert = (up: number): unknown =>
			db
				.prepare(
					`insert into daily (component, day, total, up) values ('database', '2026-11-21', 1, ?)
					 on conflict (component, day) do update set total = total + 1, up = up + excluded.up`,
				)
				.run(up);
		upsert(1);
		upsert(1);
		upsert(0);
		const row = db.prepare("select total, up from daily where component = 'database'").get();
		expect([num(row, "total"), num(row, "up")]).toEqual([3, 2]);
	});
});
