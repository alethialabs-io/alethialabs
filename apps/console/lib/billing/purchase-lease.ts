// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The purchase lease (ADR 0002 §4.4, Q2, #5741): one create-a-team purchase per user at a time,
// across every instance, WITHOUT holding a pooled connection while Stripe is called.
//
// `withPurchaseLock` (lib/billing/purchase-lock.ts) held one service connection in an open transaction
// for the whole Stripe sequence, plus up to 30s waiting; with `poolMax = 10`, ten waiters starved the
// holder. A lease is a row in `purchase_leases` instead: taken by one upsert, renewed by one update,
// released by one delete, each on its own short statement. A waiter polls; it holds nothing between
// polls.
//
// THE LEASE CAN EXPIRE MID-PURCHASE, AND NOTHING CAN FENCE A STRIPE WRITE. A request that stalls past
// `PURCHASE_LEASE_TTL_SECONDS` can be taken over by another; when the stalled one wakes, its writes
// still reach Stripe. So the holder is a fencing token, and the caller follows the rules of §4.4:
//   1. renew before every Stripe write — a renewal that matches no row means the lease is lost, and
//      the holder stops (`fenceFor` throws `PurchaseLeaseLostError`);
//   2. call `subscriptions.create` only when the renewal leaves more than the mint's worst case;
//   3. after the mint, renew once more before the client secret leaves the server (the artifact gate);
//   4. after a failed gate, make only the writes that close what this request minted (the close-out).
// Rules 2–4 are the caller's (app/server/actions/billing.ts); this module gives it the renewal they
// are built on. A fence narrows the window but cannot close it: a request that pauses after a
// successful renewal and before its write (a GC pause, a slow event loop) still writes. The ADR accepts
// that for the sweep's cancels and refunds; only the mint's secret is gated, by rule 3.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { purchaseLeases } from "@/lib/db/schema";

/** How long a lease lasts from its last acquisition or renewal. */
const PURCHASE_LEASE_TTL_SECONDS = 120;

/** How long a purchase waits for another one on the same key before it gives up. */
const PURCHASE_LEASE_WAIT_MS = 30_000;

/** How long a waiter sleeps between two attempts to take a busy lease. */
const POLL_INTERVAL_MS = 250;

/** A lease this request holds: the key, and the token that proves it is still this request's. */
export interface PurchaseLease {
	readonly key: string;
	readonly holder: string;
}

/**
 * Thrown by a fence (`fenceFor`) when the renewal before a Stripe write matched no row: another
 * request took the lease over. The holder must make no further Stripe write.
 */
export class PurchaseLeaseLostError extends Error {
	constructor(readonly key: string) {
		super(`The purchase lease ${key} was lost before a Stripe write.`);
		this.name = "PurchaseLeaseLostError";
	}
}

/**
 * Runs before each Stripe write of a purchase. Under a lease it renews it, and throws
 * `PurchaseLeaseLostError` when the lease is lost; `UNFENCED` does nothing.
 */
export type StripeWriteFence = () => Promise<void>;

/**
 * The fence of a flow that holds no lease — the org-plan purchase, which keeps `withPurchaseLock`
 * (ADR 0002 §7). Its Stripe writes are not renewed against anything.
 */
export const UNFENCED: StripeWriteFence = async () => undefined;

/** `now() + the lease's lifetime`, computed by the database so every instance shares one clock. */
const leaseExpiry = sql`now() + (${PURCHASE_LEASE_TTL_SECONDS}::int * interval '1 second')`;

/**
 * Takes the lease for `key` once, without waiting: inserts it, or replaces a row whose `expires_at`
 * has passed (a crashed or stalled holder). Returns the lease, or null when a live holder has it.
 */
export async function tryAcquirePurchaseLease(key: string): Promise<PurchaseLease | null> {
	const holder = randomUUID();
	const rows = await getServiceDb()
		.insert(purchaseLeases)
		.values({ key, holder, expires_at: leaseExpiry })
		.onConflictDoUpdate({
			target: purchaseLeases.key,
			set: { holder, expires_at: leaseExpiry },
			setWhere: sql`${purchaseLeases.expires_at} < now()`,
		})
		.returning({ holder: purchaseLeases.holder });
	return rows[0]?.holder === holder ? { key, holder } : null;
}

/**
 * Takes the lease for `key`, polling every `POLL_INTERVAL_MS` for up to `waitMs` while another holder
 * has it. No connection is held between attempts. Returns null when the wait elapses.
 */
export async function acquirePurchaseLease(
	key: string,
	waitMs: number = PURCHASE_LEASE_WAIT_MS,
): Promise<PurchaseLease | null> {
	const until = Date.now() + waitMs;
	for (;;) {
		const lease = await tryAcquirePurchaseLease(key);
		if (lease) return lease;
		if (Date.now() + POLL_INTERVAL_MS > until) return null;
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

/**
 * Renews `lease` for another `PURCHASE_LEASE_TTL_SECONDS` (§4.4 rule 1). True only when the row still
 * names this holder AND the renewed lease has more than `minRemainingMs` left by the database's clock
 * (rule 2's mint deadline). A lease taken over by another request matches no row: false. A renewal sets
 * the full lifetime and measures it against the same `now()`, so a held lease always reports the whole
 * lifetime left: `minRemainingMs` refuses only a value above `PURCHASE_LEASE_TTL_SECONDS`.
 */
export async function renewPurchaseLease(lease: PurchaseLease, minRemainingMs = 0): Promise<boolean> {
	const rows = await getServiceDb()
		.update(purchaseLeases)
		.set({ expires_at: leaseExpiry })
		.where(and(eq(purchaseLeases.key, lease.key), eq(purchaseLeases.holder, lease.holder)))
		.returning({
			remainingMs: sql<number>`extract(epoch from (${purchaseLeases.expires_at} - now())) * 1000`.mapWith(Number),
		});
	const row = rows[0];
	return !!row && row.remainingMs > minRemainingMs;
}

/**
 * The fence for `lease`: renews it before a Stripe write, and throws `PurchaseLeaseLostError` when the
 * renewal fails. A renewal that throws (the database is unreachable) is thrown as it is — nothing
 * proves the lease is still held, so the write must not run either way.
 */
export function fenceFor(lease: PurchaseLease, minRemainingMs = 0): StripeWriteFence {
	return async () => {
		if (!(await renewPurchaseLease(lease, minRemainingMs))) throw new PurchaseLeaseLostError(lease.key);
	};
}

/** Gives `lease` back, only while this holder still has it. A lease taken over is left alone. */
export async function releasePurchaseLease(lease: PurchaseLease): Promise<void> {
	await getServiceDb()
		.delete(purchaseLeases)
		.where(and(eq(purchaseLeases.key, lease.key), eq(purchaseLeases.holder, lease.holder)));
}

/**
 * Runs `fn` holding the lease for `key`, then releases it. Waits up to `waitMs` for it; when that
 * elapses `fn` is not run and the result is `{ acquired: false }`. Anything `fn` throws is thrown. A
 * release that fails is logged, not thrown: the lease then lapses on its own after its lifetime.
 */
export async function withPurchaseLease<T>(
	key: string,
	fn: (lease: PurchaseLease) => Promise<T>,
	waitMs: number = PURCHASE_LEASE_WAIT_MS,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
	const lease = await acquirePurchaseLease(key, waitMs);
	if (!lease) return { acquired: false };
	try {
		return { acquired: true, value: await fn(lease) };
	} finally {
		try {
			await releasePurchaseLease(lease);
		} catch (e) {
			console.error(`[billing] could not release the purchase lease ${key}; it lapses on its own:`, e);
		}
	}
}
