// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's shared rate limiter (#5309). Buckets live in Postgres (`rate_limit_buckets`,
// lib/db/schema/rate-limit-buckets.ts), so every replica counts against ONE budget and a deploy does
// not reset it. Until #5309 they lived in process memory: with N replicas every limit was N× what its
// constant said, and each deploy handed everybody a fresh budget.
//
// ONE STATEMENT. A hit is `INSERT … ON CONFLICT (key, window_start) DO UPDATE SET hits = hits + 1
// WHERE hits < limit RETURNING hits`. The conflicting row is locked and the WHERE is re-evaluated
// against its latest version, so N concurrent hits on a full-but-one bucket admit exactly one. No row
// back means the bucket is full: the hit is refused and NOT counted, as the in-memory limiter did.
//
// FIXED WINDOWS, not the in-memory limiter's sliding one. A window starts at a multiple of `windowMs`
// on the database clock (every replica asks the same clock, so they agree on the window). The cost is
// the usual fixed-window edge: a caller can spend a full budget at the end of one window and another at
// the start of the next, so the worst burst is 2× the limit over one window length — bounded, and far
// below the N× the per-process buckets allowed.
//
// FAIL MODE. A database error is not a verdict. `failOpen` (default false) says what the caller wants
// when the store cannot answer: closed refuses the hit (the caller answers as it does for "too many"),
// open admits it. Security-sensitive callers — the kubeconfig mint and the CLI sign-in routes — stay
// closed; only a caller whose limit is a courtesy may opt into open. The choice is made at each call
// site, where the reason is visible.
//
// EXPIRY. Old windows are deleted by `sweepExpiredRateLimitBuckets`, which the reconcile loop runs as
// `rate-limit-sweep` (lib/reconcile/loop.ts).

import { lte, sql } from "drizzle-orm";
import { type Db, getServiceDb } from "@/lib/db";
import { rateLimitBuckets } from "@/lib/db/schema";
import { errorName } from "@/lib/errors";
import { log } from "@/lib/observability/log";

const rlog = log.child({ component: "rate-limit" });

export interface RateLimitResult {
	ok: boolean;
	remaining: number;
}

/** How one {@link checkRateLimit} call behaves beyond its budget. */
export interface RateLimitOptions {
	/**
	 * What to answer when the bucket store cannot be reached or errors. `false` (the default) refuses
	 * the hit — the safe answer for anything security-sensitive. `true` admits it; use it only where the
	 * limit is a courtesy and an outage should not also take the feature down.
	 */
	failOpen?: boolean;
	/** The instant to count the hit at. Defaults to the DATABASE clock; tests pin it. */
	now?: Date;
	/** The database to count in. Defaults to the service connection; tests pass a second pool. */
	db?: Db;
}

/**
 * Records a hit for `key` and reports whether it is within `limit` per fixed `windowMs` window.
 * One atomic statement against the shared bucket table, so concurrent callers on any replica cannot
 * together exceed the limit. A refused hit is not counted. On a database error, answers per
 * `options.failOpen` (closed by default) and logs the error's name only.
 */
export async function checkRateLimit(
	key: string,
	limit: number,
	windowMs: number,
	options: RateLimitOptions = {},
): Promise<RateLimitResult> {
	const failOpen = options.failOpen ?? false;
	if (limit <= 0) return { ok: false, remaining: 0 };
	if (!Number.isInteger(windowMs) || windowMs <= 0) {
		throw new Error(`checkRateLimit: windowMs must be a positive integer, got ${windowMs}`);
	}

	const at = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`now()`;
	// Epoch milliseconds floored to the window — the same arithmetic on every replica, on one clock.
	const windowStart = sql`to_timestamp(floor(extract(epoch from ${at}) * 1000 / ${windowMs}::numeric) * ${windowMs}::numeric / 1000)`;

	try {
		const db = options.db ?? getServiceDb();
		const rows = await db
			.insert(rateLimitBuckets)
			.values({
				key,
				window_start: windowStart,
				hits: 1,
				expires_at: sql`${windowStart} + make_interval(secs => ${windowMs}::double precision / 1000)`,
			})
			.onConflictDoUpdate({
				target: [rateLimitBuckets.key, rateLimitBuckets.window_start],
				set: { hits: sql`${rateLimitBuckets.hits} + 1` },
				setWhere: sql`${rateLimitBuckets.hits} < ${limit}::integer`,
			})
			.returning({ hits: rateLimitBuckets.hits });

		const row = rows[0];
		if (row === undefined) return { ok: false, remaining: 0 };
		return { ok: true, remaining: Math.max(0, limit - row.hits) };
	} catch (e) {
		// The name only: a driver error's message quotes the statement's parameters, and the key can
		// carry a client IP or a user id.
		rlog.error("rate-limit store unavailable", { error: errorName(e), failOpen });
		return failOpen ? { ok: true, remaining: 0 } : { ok: false, remaining: 0 };
	}
}

/** What one sweep pass did. A type alias so it is assignable to the heartbeat's result shape. */
export type RateLimitSweepResult = { deleted: number };

/**
 * Deletes every bucket whose window has ended (on the database clock). Idempotent and safe under
 * concurrent replicas: a second pass finds the rows already gone. Hosted on the reconcile loop.
 */
export async function sweepExpiredRateLimitBuckets(db: Db): Promise<RateLimitSweepResult> {
	const deleted = await db
		.delete(rateLimitBuckets)
		.where(lte(rateLimitBuckets.expires_at, sql`now()`))
		.returning({ key: rateLimitBuckets.key });
	return { deleted: deleted.length };
}
