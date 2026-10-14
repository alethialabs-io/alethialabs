// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6028): the backend holding a transaction is terminated while the transaction's
// callback is still running (an admin kill, `idle_in_transaction_session_timeout`, a failover).
//
// The callback is not stopped by the kill. On unpatched postgres@3.4.9 its next statement, or the
// COMMIT postgres-js sends when it returns, goes to the same connection object, with two outcomes:
//   - The connection is still closed: the write throws `TypeError: Cannot read properties of null
//     (reading 'write')` from a setImmediate, outside any promise, and leaves the write buffer stuck,
//     so every later query on that connection fails with CONNECT_TIMEOUT or hangs (#6028).
//   - A pool query has reconnected it: the statement runs on the new session outside any
//     transaction and commits on its own, while the statements before the kill were rolled back
//     (#6041, porsager/postgres#1248).
// patches/postgres@3.4.9.patch makes begin() reject every statement of a transaction whose session
// has closed, so neither write happens, and makes a write that does reach a closed socket reject
// with CONNECTION_CLOSED (exercised here through reserve(), which has no such begin() guard).
//
// These pin, against real Postgres:
//   1. The caller of the killed transaction gets postgres-js's CONNECTION_CLOSED error, and so does
//      every statement the transaction issues after the kill.
//   2. Nothing the transaction wrote commits, before or after the kill.
//   3. No uncaught exception fires.
//   4. The pool recovers: later queries succeed promptly.
//
// The service pool is shrunk to 1 for this file (`vi.hoisted` runs before any module reads the
// config), so every later query has to go through the connection that was killed.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getServiceDb, type Tx } from "@/lib/db";
import { describeIfDb } from "./db";

vi.hoisted(() => {
	process.env.ALETHIA_DB_POOL_MAX = "1";
});

const uncaught: unknown[] = [];

/** Records an uncaught exception so a test can assert none fired. */
function recordUncaught(e: unknown): void {
	uncaught.push(e);
}

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Rejects with "stalled" when `p` has not settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("stalled")), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Settles to the rejection's `code` property, or "resolved" when `p` resolves. drizzle wraps a
 * driver error as "Failed query: …" with the driver's error as `cause`, so the cause's code is
 * used when the error has none of its own.
 */
async function settledCode(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
		return "resolved";
	} catch (e: unknown) {
		if (!(e instanceof Error)) return e;
		const own: unknown = Reflect.get(e, "code");
		if (own !== undefined) return own;
		return e.cause instanceof Error ? Reflect.get(e.cause, "code") : undefined;
	}
}

const PROBE_TABLE = "db_connection_kill_probe";

/** The ids from `ids` that a committed row in the probe table holds, read outside the app's pools. */
async function committedIds(ids: string[]): Promise<string[]> {
	const admin = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
	try {
		const rows = await admin`select id from ${admin(PROBE_TABLE)} where id in ${admin(ids)} order by id`;
		return rows.map((r) => String(r.id));
	} finally {
		await admin.end();
	}
}

/** Inserts `id` into the probe table through `tx`. */
function insertProbe(tx: Tx, id: string): Promise<unknown> {
	return tx.execute(sql`insert into ${sql.identifier(PROBE_TABLE)} (id) values (${id})`);
}

/** Runs one pool query and returns the backend pid that served it. */
async function poolBackendPid(): Promise<number> {
	const rows = await getServiceDb().execute(sql`select pg_backend_pid() as pid`);
	return Number(rows[0]?.pid);
}

/** Terminates the backend with process id `pid`, from a connection outside the app's pools. */
async function terminateBackend(pid: number): Promise<void> {
	const admin = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
	try {
		await admin`select pg_terminate_backend(${pid})`;
	} finally {
		await admin.end();
	}
}

/**
 * Starts a service transaction that records its backend pid and runs `before` on its transaction
 * handle, then waits for `release` before running `after` on it. Resolves `started` once `before`
 * has finished, and `done` once `after` has.
 */
function killableTransaction(after: (tx: Tx) => Promise<void>, before: (tx: Tx) => Promise<unknown> = async () => undefined) {
	const started = deferred();
	const release = deferred();
	const done = deferred();
	let pid = 0;
	const tx = getServiceDb().transaction(async (t) => {
		const rows = await t.execute(sql`select pg_backend_pid() as pid`);
		pid = Number(rows[0]?.pid);
		await before(t);
		started.resolve();
		await release.promise;
		try {
			await after(t);
		} finally {
			done.resolve();
		}
		return "committed";
	});
	return { tx, started: started.promise, release: release.resolve, done: done.promise, pid: () => pid };
}

describeIfDb("a backend killed mid-transaction (#6028)", () => {
	beforeAll(async () => {
		process.on("uncaughtException", recordUncaught);
		await getServiceDb().execute(sql`create table if not exists ${sql.identifier(PROBE_TABLE)} (id text primary key)`);
	});
	afterAll(async () => {
		process.off("uncaughtException", recordUncaught);
		await getServiceDb().execute(sql`drop table if exists ${sql.identifier(PROBE_TABLE)}`);
	});

	it("the callback finishing after the kill: the caller gets CONNECTION_CLOSED and the pool recovers", async () => {
		uncaught.length = 0;
		const k = killableTransaction(async () => undefined);
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");

		// The callback returns now. The patched begin() rejects the COMMIT postgres-js issues for it,
		// because the transaction's session has closed, so nothing is written on the connection.
		k.release();
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);

		await expect(within(getServiceDb().execute(sql`select 1 as one`), 5000)).resolves.toEqual([{ one: 1 }]);
		await expect(within(getServiceDb().execute(sql`select 2 as two`), 5000)).resolves.toEqual([{ two: 2 }]);
		expect(uncaught.map(String)).toEqual([]);
	});

	it("the callback writing while the pool reconnects that connection: the write rejects and the pool recovers", async () => {
		uncaught.length = 0;
		let written: unknown = "not run";
		const k = killableTransaction(async (t) => {
			written = await settledCode(t.execute(sql`select 1`));
		});
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");

		// This query makes the pool reconnect the killed connection, and the callback issues its
		// statement while that reconnect is pending. The patched begin() rejects the statement
		// without writing it, so the reconnect carries only this query.
		const during = settledCode(getServiceDb().execute(sql`select 3 as three`));
		k.release();
		await within(k.done, 5000);
		expect(written).toBe("CONNECTION_CLOSED");
		expect(await within(during, 5000)).toBe("resolved");
		await expect(within(getServiceDb().execute(sql`select 4 as four`), 5000)).resolves.toEqual([{ four: 4 }]);
		await expect(within(getServiceDb().execute(sql`select 5 as five`), 5000)).resolves.toEqual([{ five: 5 }]);
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);
	});

	it("the callback writing after the pool reconnected that connection: the write rejects and nothing commits (#6041)", async () => {
		uncaught.length = 0;
		const beforeKill = `before-${randomUUID()}`;
		const afterKill = `after-${randomUUID()}`;
		let afterOutcome: unknown = "not run";
		const k = killableTransaction(async (t) => {
			afterOutcome = await settledCode(insertProbe(t, afterKill));
		}, (t) => insertProbe(t, beforeKill));
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");

		// The pool has one connection, so this query reconnects the one the transaction was on. It
		// is a new backend, and it is open before the callback's next statement is issued.
		const reconnectedPid = await within(poolBackendPid(), 5000);
		expect(reconnectedPid).not.toBe(k.pid());

		k.release();
		await within(k.done, 5000);
		expect(afterOutcome).toBe("CONNECTION_CLOSED");
		expect(await committedIds([beforeKill, afterKill])).toEqual([]);

		await expect(within(poolBackendPid(), 5000)).resolves.toBe(reconnectedPid);
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);
	});

	it("a nested transaction (savepoint) opened after the reconnect: its write rejects and nothing commits (#6041)", async () => {
		uncaught.length = 0;
		const nested = `nested-${randomUUID()}`;
		let nestedOutcome: unknown = "not run";
		const k = killableTransaction(async (t) => {
			nestedOutcome = await settledCode(t.transaction((n) => insertProbe(n, nested)));
		});
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");
		expect(await within(poolBackendPid(), 5000)).not.toBe(k.pid());

		k.release();
		await within(k.done, 5000);
		expect(nestedOutcome).toBe("CONNECTION_CLOSED");
		expect(await committedIds([nested])).toEqual([]);
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);
	});

	it("a write on a reserved connection whose backend is gone rejects with CONNECTION_CLOSED instead of throwing uncaught", async () => {
		uncaught.length = 0;
		const client = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		try {
			const reserved = await client.reserve();
			const [row] = await reserved`select pg_backend_pid() as pid`;
			await terminateBackend(Number(row?.pid));
			// Let the close be processed, so the connection's socket is gone before the next write.
			await new Promise((r) => setTimeout(r, 200));
			expect(await within(settledCode(reserved`select 1`), 5000)).toBe("CONNECTION_CLOSED");
			await new Promise((r) => setTimeout(r, 200));
			expect(uncaught.map(String)).toEqual([]);
		} finally {
			await client.end({ timeout: 0 });
		}
	});

	it("a statement queued behind the one in flight when the backend dies: it rejects instead of hanging (#6041)", async () => {
		uncaught.length = 0;
		const queued = `queued-${randomUUID()}`;
		let inFlight: Promise<unknown> = Promise.resolve();
		let behind: Promise<unknown> = Promise.resolve();
		// A statement with parameters is sent with a describe step, so postgres-js holds every later
		// statement of the transaction in the transaction's own queue until it completes.
		const k = killableTransaction(async () => undefined, (t) => {
			inFlight = settledCode(t.execute(sql`select pg_sleep(${10})`));
			behind = settledCode(insertProbe(t, queued));
			return Promise.resolve();
		});
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");
		expect(await within(inFlight, 5000)).toBe("CONNECTION_CLOSED");
		expect(await within(behind, 5000)).toBe("CONNECTION_CLOSED");

		// The FATAL that ended the in-flight statement is still held by the connection, and postgres-js
		// rejects the first query on the reconnected session with it without sending that query
		// (the "Related" section of porsager/postgres#1248; not patched here). The next one succeeds.
		expect(["resolved", "57P01"]).toContain(await within(settledCode(poolBackendPid()), 5000));
		await expect(within(poolBackendPid(), 5000)).resolves.not.toBe(k.pid());
		k.release();
		await within(k.done, 5000);
		expect(await committedIds([queued])).toEqual([]);
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);
	});
});
