// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit cover for the `release-cancelled-state-locks` sweep (#7387), with the database faked.
//
// What this proves: the module is wired — each candidate's locks are released through
// releaseStateLocksForJob ON THE PAGE'S TRANSACTION (the job row is locked there, so the service pool
// would wait on it), a released job gets its SYSTEM log line and a job_logs notification, a job with
// nothing to release gets neither, the counts come from what was released, the candidate query is
// bounded by the shared drain constant and locks `SKIP LOCKED`, and paging stops on a short page or
// at the bound.
//
// What it does NOT prove: that the SQL selects the right jobs. That is
// tests/integration/state-lock-sweep.test.ts, against real Postgres — a cancelled job past the window
// released and its DESTROY claimable, one inside the window left alone, a live job left alone.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const releaseStateLocksForJob = vi.hoisted(() => vi.fn(async (_id: string, _tx: unknown) => 1));
vi.mock("@/lib/runners/state-lock", () => ({ releaseStateLocksForJob }));

import { CANCELLED_HOLDER_DRAIN_MS } from "@/lib/runners/state-auth";
import { LOCK_RELEASED_LOG_LINE, releaseCancelledStateLocks } from "@/lib/reconcile/state-locks";

const dialect = new PgDialect();

/** One statement the fake transaction was asked to run, rendered to text + params. */
interface Ran {
	tx: number;
	text: string;
	params: unknown[];
}

/**
 * A fake service pool. Each `transaction` gets a fresh tx whose `execute` records the statement and
 * answers it: the candidate query with the next page of ids, the log insert with a log id, anything
 * else with no rows.
 */
function fakeDb(pages: string[][]) {
	const ran: Ran[] = [];
	const txs: unknown[] = [];
	let page = 0;
	const db = {
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			const n = txs.length;
			const tx = {
				execute: async (q: SQL) => {
					const { sql: text, params } = dialect.sqlToQuery(q);
					ran.push({ tx: n, text, params });
					if (text.includes("skip locked")) {
						return (pages[page++] ?? []).map((id) => ({ id }));
					}
					if (text.includes("insert into public.job_logs")) return [{ id: 7 }];
					return [];
				},
			};
			txs.push(tx);
			return fn(tx);
		},
	};
	// The fake implements only the calls the module makes, as the other reconcile fakes do.
	return { db: db as never, ran, txs };
}

describe("releaseCancelledStateLocks", () => {
	beforeEach(() => {
		releaseStateLocksForJob.mockReset();
		releaseStateLocksForJob.mockResolvedValue(1);
	});

	it("releases each candidate on the page's transaction and logs it on the job", async () => {
		const { db, ran, txs } = fakeDb([["job-a", "job-b"]]);
		expect(await releaseCancelledStateLocks(db)).toEqual({ jobs: 2, released: 2 });

		expect(releaseStateLocksForJob.mock.calls.map((c) => c[0])).toEqual(["job-a", "job-b"]);
		for (const call of releaseStateLocksForJob.mock.calls) expect(call[1]).toBe(txs[0]);

		const inserts = ran.filter((r) => r.text.includes("insert into public.job_logs"));
		expect(inserts).toHaveLength(2);
		expect(inserts[0].text).toContain("'SYSTEM'");
		expect(inserts[0].params).toEqual([LOCK_RELEASED_LOG_LINE, "job-a"]);
		expect(ran.filter((r) => r.text.includes("pg_notify('job_logs'"))).toHaveLength(2);
	});

	it("writes nothing on a job whose lock was already gone, and does not count it", async () => {
		releaseStateLocksForJob.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
		const { db, ran } = fakeDb([["late-reported", "held-two"]]);
		expect(await releaseCancelledStateLocks(db)).toEqual({ jobs: 1, released: 2 });
		const inserts = ran.filter((r) => r.text.includes("insert into public.job_logs"));
		expect(inserts.map((r) => r.params[1])).toEqual(["held-two"]);
	});

	it("bounds the candidates by the shared drain window, and locks them SKIP LOCKED", async () => {
		const { db, ran } = fakeDb([[]]);
		await releaseCancelledStateLocks(db, { pageSize: 25, maxPages: 3 });
		const [query] = ran;
		expect(query.text).toContain("j.status = 'CANCELLED'");
		expect(query.text).toContain("for update of j skip locked");
		expect(query.params).toEqual([CANCELLED_HOLDER_DRAIN_MS / 1000, 25]);
	});

	it("stops paging on a short page", async () => {
		const { db, txs } = fakeDb([["a", "b"], ["c"], ["never-read"]]);
		expect(await releaseCancelledStateLocks(db, { pageSize: 2, maxPages: 10 })).toEqual({
			jobs: 3,
			released: 3,
		});
		expect(txs).toHaveLength(2);
	});

	it("stops at the page bound with a backlog left for the next run", async () => {
		const { db, txs } = fakeDb([["a"], ["b"], ["c"]]);
		expect(await releaseCancelledStateLocks(db, { pageSize: 1, maxPages: 2 })).toEqual({
			jobs: 2,
			released: 2,
		});
		expect(txs).toHaveLength(2);
	});
});
