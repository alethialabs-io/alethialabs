// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-payer purchase lock (#5489). A purchase sweeps the payer's `incomplete`
// subscriptions, and mints a new one. Two requests that ran those steps side by side (two tabs, a
// double click) each read "nothing in flight" before either minted, and each minted a payable
// subscription. This lock runs them one after another for the same key: the second request starts
// only after the first has minted (and recorded) its subscription, so its sweep sees that one.
//
// It is a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`, the pattern
// lib/billing/webhook-events.ts uses), held on one service connection for the whole purchase. The
// work inside does not run in that transaction: its own reads and writes go through `getServiceDb()`
// and commit on their own. The transaction exists only to hold the lock, and Postgres releases it at
// commit or rollback, so a crashed request cannot leave it held.

import "server-only";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { pgErrorCode } from "@/lib/db/pg-error";

/** How long a purchase waits for another one on the same key before it gives up. */
const PURCHASE_LOCK_WAIT = "30s";

/** SQLSTATE `lock_not_available`: `lock_timeout` elapsed while waiting for the lock. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Runs `fn` while holding the purchase lock for `key`, so no other `withPurchaseLock` call with the
 * same key runs at the same time. Waits up to `PURCHASE_LOCK_WAIT` for it; when that elapses `fn` is
 * not run and the result is `{ acquired: false }`. Anything `fn` throws is thrown.
 */
export async function withPurchaseLock<T>(
	key: string,
	fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
	return getServiceDb().transaction(async (tx) => {
		try {
			await tx.execute(sql`select set_config('lock_timeout', ${PURCHASE_LOCK_WAIT}, true)`);
			await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`purchase:${key}`}, 0))`);
		} catch (e) {
			if (pgErrorCode(e) === LOCK_NOT_AVAILABLE) return { acquired: false };
			throw e;
		}
		return { acquired: true, value: await fn() };
	});
}
