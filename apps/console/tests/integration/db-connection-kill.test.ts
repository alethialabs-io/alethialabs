// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6028): the backend holding a transaction is terminated while the transaction's
// callback is still running (an admin kill, `idle_in_transaction_session_timeout`, a failover).
//
// The callback is not stopped by the kill, so its next statement, or the COMMIT postgres-js sends
// when it returns, is written on a connection whose socket is gone. On unpatched postgres@3.4.9 that
// write throws `TypeError: Cannot read properties of null (reading 'write')` from a setImmediate,
// outside any promise, and leaves the connection's write buffer stuck: the reconnect never sends its
// startup message, so every later query on that connection fails with CONNECT_TIMEOUT after 30s, or
// hangs. patches/postgres@3.4.9.patch rejects that write with CONNECTION_CLOSED instead.
//
// These pin, against real Postgres:
//   1. The caller of the killed transaction gets postgres-js's CONNECTION_CLOSED error.
//   2. No uncaught exception fires.
//   3. The pool recovers: later queries succeed promptly.
//
// The service pool is shrunk to 1 for this file (`vi.hoisted` runs before any module reads the
// config), so every later query has to go through the connection that was killed.
//
// Not covered, and not fixed: a statement the callback issues after the pool has reconnected that
// connection runs on the new session, outside any transaction (porsager/postgres#1248).

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

/** Settles to the rejection's `code` property, or "resolved" when `p` resolves. */
async function settledCode(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
		return "resolved";
	} catch (e: unknown) {
		return e instanceof Error ? Reflect.get(e, "code") : e;
	}
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
 * Starts a service transaction that records its backend pid, then waits for `release` before
 * running `after` on its transaction handle. Resolves `started` once the pid is known.
 */
function killableTransaction(after: (tx: Tx) => Promise<void>) {
	const started = deferred();
	const release = deferred();
	let pid = 0;
	const tx = getServiceDb().transaction(async (t) => {
		const rows = await t.execute(sql`select pg_backend_pid() as pid`);
		pid = Number(rows[0]?.pid);
		started.resolve();
		await release.promise;
		await after(t);
		return "committed";
	});
	return { tx, started: started.promise, release: release.resolve, pid: () => pid };
}

describeIfDb("a backend killed mid-transaction (#6028)", () => {
	beforeAll(() => {
		process.on("uncaughtException", recordUncaught);
	});
	afterAll(() => {
		process.off("uncaughtException", recordUncaught);
	});

	it("the callback finishing after the kill: the caller gets CONNECTION_CLOSED and the pool recovers", async () => {
		uncaught.length = 0;
		const k = killableTransaction(async () => undefined);
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");

		// The callback returns now, so postgres-js sends COMMIT on the closed connection.
		k.release();
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);

		await expect(within(getServiceDb().execute(sql`select 1 as one`), 5000)).resolves.toEqual([{ one: 1 }]);
		await expect(within(getServiceDb().execute(sql`select 2 as two`), 5000)).resolves.toEqual([{ two: 2 }]);
		expect(uncaught.map(String)).toEqual([]);
	});

	it("the callback writing while the pool reconnects that connection: the pool still recovers", async () => {
		uncaught.length = 0;
		const k = killableTransaction(async (t) => {
			await t.execute(sql`select 1`).catch(() => undefined);
		});
		const outcome = settledCode(k.tx);
		await within(k.started, 5000);
		await terminateBackend(k.pid());
		expect(await within(outcome, 5000)).toBe("CONNECTION_CLOSED");

		// This query makes the pool reconnect the killed connection; the callback's statement is
		// written while that reconnect is pending. The patch rejects every query pending on that
		// connection when the write fails, so this one can be rejected with CONNECTION_CLOSED too
		// (on macOS it is, every run). Either way it settles promptly instead of hanging.
		const during = settledCode(
			getServiceDb()
				.execute(sql`select 3 as three`)
				.catch((e: unknown) => {
					// drizzle wraps the driver error as "Failed query: …" with the driver's error as `cause`.
					throw e instanceof Error && e.cause instanceof Error ? e.cause : e;
				}),
		);
		k.release();
		expect(["resolved", "CONNECTION_CLOSED"]).toContain(await within(during, 5000));
		await expect(within(getServiceDb().execute(sql`select 4 as four`), 5000)).resolves.toEqual([{ four: 4 }]);
		await expect(within(getServiceDb().execute(sql`select 5 as five`), 5000)).resolves.toEqual([{ five: 5 }]);
		await new Promise((r) => setTimeout(r, 200));
		expect(uncaught.map(String)).toEqual([]);
	});
});
