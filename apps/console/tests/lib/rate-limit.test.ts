// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// lib/rate-limit.ts's own decisions, over a stubbed database: how a returned row (or none) becomes a
// verdict, which clock the window is computed on, how a database error is answered per `failOpen`,
// and what the sweep reports. Whether the statement is actually atomic and shared across pools is a
// property of Postgres, not of this code — tests/integration/rate-limit.test.ts drives that.

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the stubbed insert chain was handed, and what it will answer. */
interface StubState {
	values: unknown[];
	conflict: unknown[];
	rows: Array<{ hits: number }>;
	error: Error | null;
	deleted: Array<{ key: string }>;
	calls: number;
}
const insert = vi.hoisted((): StubState => ({
	values: [],
	conflict: [],
	rows: [],
	error: null,
	deleted: [],
	calls: 0,
}));

const logged = vi.hoisted((): unknown[] => []);

vi.mock("@/lib/observability/log", () => {
	const logger = {
		info: () => undefined,
		warn: () => undefined,
		debug: () => undefined,
		error: (...a: unknown[]) => logged.push(a),
		child: () => logger,
	};
	return { log: logger };
});

vi.mock("@/lib/db", () => {
	const db = {
		insert: () => {
			insert.calls += 1;
			return {
				values: (v: unknown) => {
					insert.values.push(v);
					return {
						onConflictDoUpdate: (c: unknown) => {
							insert.conflict.push(c);
							return {
								returning: async () => {
									if (insert.error) throw insert.error;
									return insert.rows;
								},
							};
						},
					};
				},
			};
		},
		delete: () => ({ where: () => ({ returning: async () => insert.deleted }) }),
	};
	return { getServiceDb: () => db };
});

import { getServiceDb } from "@/lib/db";
import { checkRateLimit, sweepExpiredRateLimitBuckets } from "@/lib/rate-limit";

const dialect = new PgDialect();

/** Renders a drizzle SQL fragment so a test can read the statement it would send. */
function render(fragment: unknown): { sql: string; params: unknown[] } {
	if (!(fragment instanceof SQL)) throw new Error("not an SQL fragment");
	const q = dialect.sqlToQuery(fragment);
	return { sql: q.sql, params: q.params };
}

/** The `window_start` value the last insert carried. */
function lastWindowStart(): unknown {
	const v = insert.values.at(-1);
	if (typeof v !== "object" || v === null || !("window_start" in v)) throw new Error("no insert");
	return v.window_start;
}

beforeEach(() => {
	insert.values.length = 0;
	insert.conflict.length = 0;
	insert.rows = [];
	insert.error = null;
	insert.deleted = [];
	insert.calls = 0;
	logged.length = 0;
});

describe("checkRateLimit — the verdict", () => {
	it("admits when the upsert returns the row, and reports what remains", async () => {
		insert.rows = [{ hits: 3 }];
		expect(await checkRateLimit("k", 5, 60_000)).toEqual({ ok: true, remaining: 2 });
	});

	it("refuses when the guarded upsert returns no row (the bucket is full)", async () => {
		insert.rows = [];
		expect(await checkRateLimit("k", 5, 60_000)).toEqual({ ok: false, remaining: 0 });
	});

	it("counts a first hit as 1 and guards the update on the limit", async () => {
		insert.rows = [{ hits: 1 }];
		await checkRateLimit("bucket-key", 7, 60_000);
		const v = insert.values[0];
		expect(v).toMatchObject({ key: "bucket-key", hits: 1 });
		const c = insert.conflict[0];
		if (typeof c !== "object" || c === null || !("setWhere" in c)) throw new Error("no setWhere");
		const where = render(c.setWhere);
		expect(where.sql).toMatch(/"hits" < \$1::integer/);
		expect(where.params).toEqual([7]);
	});

	it("refuses a non-positive limit without asking the database", async () => {
		expect(await checkRateLimit("k", 0, 60_000)).toEqual({ ok: false, remaining: 0 });
		expect(insert.calls).toBe(0);
	});

	it("rejects a window that is not a positive whole number of milliseconds", async () => {
		await expect(checkRateLimit("k", 1, 0)).rejects.toThrow(/windowMs/);
		await expect(checkRateLimit("k", 1, 1.5)).rejects.toThrow(/windowMs/);
	});
});

describe("checkRateLimit — the clock", () => {
	it("aligns the window on the DATABASE clock by default", async () => {
		insert.rows = [{ hits: 1 }];
		await checkRateLimit("k", 1, 60_000);
		const w = render(lastWindowStart());
		expect(w.sql).toContain("now()");
		expect(w.params).toEqual([60_000, 60_000]);
	});

	it("uses a pinned instant when one is given", async () => {
		insert.rows = [{ hits: 1 }];
		const at = new Date("2026-10-02T12:00:30.000Z");
		await checkRateLimit("k", 1, 60_000, { now: at });
		const w = render(lastWindowStart());
		expect(w.sql).not.toContain("now()");
		expect(w.params).toContain(at.toISOString());
	});
});

describe("checkRateLimit — when the store cannot answer", () => {
	it("fails CLOSED by default", async () => {
		insert.error = new Error("connect ECONNREFUSED 10.0.0.5:5432 key=kubeconfig-mint:org:user");
		expect(await checkRateLimit("k", 5, 60_000)).toEqual({ ok: false, remaining: 0 });
	});

	it("fails open only when the caller asked for it", async () => {
		insert.error = new Error("boom");
		expect((await checkRateLimit("k", 5, 60_000, { failOpen: false })).ok).toBe(false);
		expect((await checkRateLimit("k", 5, 60_000, { failOpen: true })).ok).toBe(true);
	});

	it("logs the error's name only — never its message, which can quote the key", async () => {
		insert.error = new Error("Failed query: insert ... params: cli-device:start:203.0.113.7");
		await checkRateLimit("cli-device:start:203.0.113.7", 5, 60_000);
		expect(logged).toHaveLength(1);
		expect(JSON.stringify(logged)).not.toContain("203.0.113.7");
		expect(JSON.stringify(logged)).toContain("Error");
	});
});

describe("sweepExpiredRateLimitBuckets", () => {
	it("reports how many ended windows it deleted", async () => {
		insert.deleted = [{ key: "a" }, { key: "b" }];
		expect(await sweepExpiredRateLimitBuckets(getServiceDb())).toEqual({ deleted: 2 });
	});
});
