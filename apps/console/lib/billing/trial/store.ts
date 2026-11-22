// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trial ceilings' counts (REL-L19, #6907), kept apart from the decision (./ceilings.ts) so the
// decision is testable without a database and this file stays thin.
//
// NO NEW TABLE. Each counter is rows in the console's shared bucket table (`rate_limit_buckets`, the
// one lib/rate-limit.ts and the sign-up guard count in). `lib/rate-limit.ts`'s `checkRateLimit` is
// not used, because its windows are fixed and expire after one window length, and the trial needs two
// shapes it cannot express:
//   - LIFETIME (organization, person): one row per key at window_start 1970-01-01, expiring 9999-12-31,
//     so the reconcile loop's bucket sweep never removes it.
//   - TRAILING 30 DAYS (network): one row per key per UTC day, kept for 31 days; the count is the sum
//     of the rows whose day started within the last 30. Day granularity is the price of no new table.
//
// ALL OR NOTHING. A trial start reserves every counter in ONE transaction: each key's advisory lock
// is taken (in key order, so two starts cannot deadlock), every count is read, and only when all fit
// is each one incremented. A start refused by one counter spends none of the others.
//
// A RESERVATION IS RELEASED when the trial is not created after all (Stripe refused, the purchase
// lease was lost), so a transient failure cannot burn a person's only trial. Once Stripe has created
// the subscription it is never released, whatever fails after.
//
// FAILS CLOSED. A database error throws, and the trial is not started.

import { and, eq, gt, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { rateLimitBuckets } from "@/lib/db/schema";
import { firstFullCounter, type TrialCounter } from "@/lib/billing/trial/ceilings";

/** One counter's spent slot: the row it was counted in, so it can be given back. */
export interface TrialSlot {
	readonly key: string;
	readonly windowStart: Date;
}

/** What a reservation attempt decided. */
export type TrialReservationResult =
	| { readonly ok: true; readonly slots: readonly TrialSlot[] }
	| { readonly ok: false; readonly refused: TrialCounter };

/** The row filter for the slots that count towards `counter` now. */
function inWindow(counter: TrialCounter) {
	const byKey = eq(rateLimitBuckets.key, counter.key);
	if (counter.windowDays === null) return byKey;
	return and(
		byKey,
		gt(rateLimitBuckets.window_start, sql`now() - make_interval(days => ${counter.windowDays}::integer)`),
	);
}

/** The window_start a new slot of `counter` is counted in. */
function slotWindowStart(counter: TrialCounter) {
	return counter.windowDays === null
		? sql`'1970-01-01T00:00:00Z'::timestamptz`
		: sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
}

/** When a new slot of `counter` may be swept. */
function slotExpiry(counter: TrialCounter) {
	return counter.windowDays === null
		? sql`'9999-12-31T00:00:00Z'::timestamptz`
		: sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + make_interval(days => ${counter.windowDays + 1}::integer)`;
}

/**
 * Reserves one trial against every counter, or none. Returns the slots spent, or the first counter
 * (in the order given) that was already full.
 */
export async function reserveTrialSlots(counters: readonly TrialCounter[]): Promise<TrialReservationResult> {
	return getServiceDb().transaction(async (tx) => {
		const lockOrder = [...counters].map((c) => c.key).sort();
		for (const key of lockOrder) {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trial-ceiling:${key}`}, 0))`);
		}
		const used = new Map<string, number>();
		for (const counter of counters) {
			const [row] = await tx
				.select({ used: sql<number>`coalesce(sum(${rateLimitBuckets.hits}), 0)::integer` })
				.from(rateLimitBuckets)
				.where(inWindow(counter));
			used.set(counter.key, Number(row?.used ?? 0));
		}
		const full = firstFullCounter(counters, used);
		if (full !== null) return { ok: false, refused: full };

		const slots: TrialSlot[] = [];
		for (const counter of counters) {
			const [row] = await tx
				.insert(rateLimitBuckets)
				.values({
					key: counter.key,
					window_start: slotWindowStart(counter),
					hits: 1,
					expires_at: slotExpiry(counter),
				})
				.onConflictDoUpdate({
					target: [rateLimitBuckets.key, rateLimitBuckets.window_start],
					set: { hits: sql`${rateLimitBuckets.hits} + 1` },
				})
				.returning({ windowStart: rateLimitBuckets.window_start });
			if (!row) throw new Error("the trial counter write returned no row");
			slots.push({ key: counter.key, windowStart: row.windowStart });
		}
		return { ok: true, slots };
	});
}

/** Gives back the slots of a reservation whose trial was not created. Never below zero. */
export async function releaseTrialSlots(slots: readonly TrialSlot[]): Promise<void> {
	const db = getServiceDb();
	for (const slot of slots) {
		await db
			.update(rateLimitBuckets)
			.set({ hits: sql`greatest(${rateLimitBuckets.hits} - 1, 0)` })
			.where(and(eq(rateLimitBuckets.key, slot.key), eq(rateLimitBuckets.window_start, slot.windowStart)));
	}
}

/**
 * The first full counter, read without reserving anything — for deciding whether to OFFER the trial.
 * Unlocked, so it can be one start out of date; the reservation is the authority.
 */
export async function peekFullCounter(counters: readonly TrialCounter[]): Promise<TrialCounter | null> {
	const db = getServiceDb();
	const used = new Map<string, number>();
	for (const counter of counters) {
		const [row] = await db
			.select({ used: sql<number>`coalesce(sum(${rateLimitBuckets.hits}), 0)::integer` })
			.from(rateLimitBuckets)
			.where(inWindow(counter));
		used.set(counter.key, Number(row?.used ?? 0));
	}
	return firstFullCounter(counters, used);
}
