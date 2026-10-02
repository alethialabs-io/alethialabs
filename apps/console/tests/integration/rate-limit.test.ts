// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: lib/rate-limit.ts against real Postgres (#5309). The limiter used to keep its buckets in
// process memory, so with N replicas every limit was N× its constant and a deploy reset it. Each claim
// below is the thing that broke, driven against the real table:
//
//   1. Two limiters on two SEPARATE connection pools — two replicas, as far as the database can tell —
//      share one budget.
//   2. A budget resets when its window ends, and not before.
//   3. Concurrent hits never exceed the limit: N parallel calls on two pools admit exactly `limit`.
//   4. A DB error does not fail open by default — and the kubeconfig mint's own gate refuses when the
//      store cannot answer — while an explicit `failOpen: true` admits.
//   5. The sweep deletes windows that have ended and keeps the current one.

import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { rateLimitBuckets } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// The service connection, switchable to one that cannot reach any database — the only way to make the
// mint gate's own call (which takes no `db`) meet a store that cannot answer.
const state = vi.hoisted(() => ({ broken: false }));
vi.mock("@/lib/db", async (orig) => {
	const real = await orig<typeof import("@/lib/db")>();
	const { drizzle: mkDrizzle } = await import("drizzle-orm/postgres-js");
	const { default: pg } = await import("postgres");
	const schemaMod = await import("@/lib/db/schema");
	const unreachable = mkDrizzle(
		pg("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1, connect_timeout: 2 }),
		{ schema: schemaMod, casing: "snake_case" },
	);
	return { ...real, getServiceDb: () => (state.broken ? unreachable : real.getServiceDb()) };
});

import { getServiceDb } from "@/lib/db";
import { takeMintRateLimit } from "@/lib/kubeconfig-mint/gates";
import {
	checkRateLimit,
	type RateLimitResult,
	sweepExpiredRateLimitBuckets,
} from "@/lib/rate-limit";

const PREFIX = `it-rate-limit:${randomUUID()}:`;
const WINDOW_MS = 60_000;

/** A drizzle instance on its OWN postgres-js pool — a second replica, from the database's side. */
function separatePool(url: string, max = 5): { db: Db; end: () => Promise<void> } {
	const client = postgres(url, { max, prepare: false });
	return { db: drizzle(client, { schema, casing: "snake_case" }), end: () => client.end({ timeout: 2 }) };
}

/** A fresh bucket key under this file's prefix, so tests never share a budget. */
function key(): string {
	return `${PREFIX}${randomUUID()}`;
}

/** An instant in the middle of a window, so a test's hits cannot straddle a boundary. */
function midWindow(offsetWindows = 0): Date {
	const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
	return new Date(start + offsetWindows * WINDOW_MS + WINDOW_MS / 2);
}

const pools: Array<{ end: () => Promise<void> }> = [];

describeIfDb("lib/rate-limit.ts — shared Postgres buckets (#5309)", () => {
	const url = process.env.ALETHIA_DATABASE_URL ?? "";

	beforeEach(() => {
		state.broken = false;
	});

	afterAll(async () => {
		state.broken = false;
		await getServiceDb().delete(rateLimitBuckets).where(like(rateLimitBuckets.key, `${PREFIX}%`));
		await Promise.all(pools.map((p) => p.end()));
	});

	it("two limiters on separate pools share ONE budget", async () => {
		const a = separatePool(url);
		const b = separatePool(url);
		pools.push(a, b);
		const k = key();
		const now = midWindow();

		const verdicts: boolean[] = [];
		for (let i = 0; i < 6; i++) {
			const db = i % 2 === 0 ? a.db : b.db;
			verdicts.push((await checkRateLimit(k, 4, WINDOW_MS, { db, now })).ok);
		}
		// Per-process buckets would have admitted all six (three per replica, under a limit of four).
		expect(verdicts).toEqual([true, true, true, true, false, false]);

		const [row] = await a.db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, k));
		expect(row?.hits).toBe(4);
	});

	it("reports what remains after each admitted hit, and 0 once refused", async () => {
		const k = key();
		const now = midWindow();
		const seen: RateLimitResult[] = [];
		for (let i = 0; i < 4; i++) seen.push(await checkRateLimit(k, 3, WINDOW_MS, { now }));
		expect(seen).toEqual([
			{ ok: true, remaining: 2 },
			{ ok: true, remaining: 1 },
			{ ok: true, remaining: 0 },
			{ ok: false, remaining: 0 },
		]);
	});

	it("resets when the window ends — and not a moment before", async () => {
		const k = key();
		const start = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
		const first = new Date(start + 1);
		const lastMsOfWindow = new Date(start + WINDOW_MS - 1);
		const nextWindow = new Date(start + WINDOW_MS);

		expect((await checkRateLimit(k, 2, WINDOW_MS, { now: first })).ok).toBe(true);
		expect((await checkRateLimit(k, 2, WINDOW_MS, { now: first })).ok).toBe(true);
		expect((await checkRateLimit(k, 2, WINDOW_MS, { now: lastMsOfWindow })).ok).toBe(false);
		expect(await checkRateLimit(k, 2, WINDOW_MS, { now: nextWindow })).toEqual({
			ok: true,
			remaining: 1,
		});
	});

	it("never admits more than the limit under concurrent hits from two pools", async () => {
		const a = separatePool(url, 10);
		const b = separatePool(url, 10);
		pools.push(a, b);
		const k = key();
		const now = midWindow();
		const N = 60;
		const LIMIT = 7;

		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				checkRateLimit(k, LIMIT, WINDOW_MS, { db: i % 2 === 0 ? a.db : b.db, now }),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(LIMIT);
		// Every admitted hit saw a distinct count, so no two of them read the same row version.
		expect(new Set(results.filter((r) => r.ok).map((r) => r.remaining)).size).toBe(LIMIT);

		const [row] = await a.db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, k));
		expect(row?.hits).toBe(LIMIT);
	});

	it("refuses on a database error by default, and admits only when the caller chose failOpen", async () => {
		const dead = separatePool("postgres://nobody:nothing@127.0.0.1:1/none", 1);
		pools.push(dead);
		const k = key();

		expect(await checkRateLimit(k, 5, WINDOW_MS, { db: dead.db })).toEqual({
			ok: false,
			remaining: 0,
		});
		expect((await checkRateLimit(k, 5, WINDOW_MS, { db: dead.db, failOpen: false })).ok).toBe(false);
		expect((await checkRateLimit(k, 5, WINDOW_MS, { db: dead.db, failOpen: true })).ok).toBe(true);
	});

	it("the kubeconfig mint gate refuses when the store cannot answer — it is a fail-closed caller", async () => {
		const actor = { orgId: randomUUID(), userId: randomUUID() };
		// Reachable: the gate admits a first request.
		expect(await takeMintRateLimit(actor)).toBe(true);
		// Unreachable: the same actor, far under budget, is refused.
		state.broken = true;
		expect(await takeMintRateLimit(actor)).toBe(false);
		state.broken = false;
		await getServiceDb()
			.delete(rateLimitBuckets)
			.where(eq(rateLimitBuckets.key, `kubeconfig-mint:${actor.orgId}:${actor.userId}`));
	});

	it("the sweep deletes windows that have ended and keeps the current one", async () => {
		const db = getServiceDb();
		const old = key();
		const current = key();
		// A window an hour ago, by the pinned clock: its expires_at is long past on the DB clock.
		await checkRateLimit(old, 5, WINDOW_MS, { now: new Date(Date.now() - 3_600_000) });
		await checkRateLimit(current, 5, WINDOW_MS, { now: midWindow(1) });

		const result = await sweepExpiredRateLimitBuckets(db);
		expect(result.deleted).toBeGreaterThanOrEqual(1);

		const left = await db
			.select({ key: rateLimitBuckets.key })
			.from(rateLimitBuckets)
			.where(like(rateLimitBuckets.key, `${PREFIX}%`));
		const keys = left.map((r) => r.key);
		expect(keys).not.toContain(old);
		expect(keys).toContain(current);
	});
});
