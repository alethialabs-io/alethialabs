// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-payer purchase lock (#5489). A purchase sweeps the payer's `incomplete`
// subscriptions, and mints a new one. Two requests that ran those steps side by side (two tabs, a
// double click) each read "nothing in flight" before either minted, and each minted a payable
// subscription. This lock runs them one after another for the same key: the second request starts
// only after the first has minted (and recorded) its subscription, so its sweep sees that one.
//
// It is a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock`, the pattern
// lib/billing/webhook-events.ts uses), held on one connection for the whole purchase. The work inside
// does not run in that transaction: its own reads and writes go through `getServiceDb()` and commit on
// their own. The transaction exists only to hold the lock, and Postgres releases it at commit or
// rollback, so a crashed request cannot leave it held.
//
// THE LOCK'S CONNECTION IS NOT A SERVICE-POOL CONNECTION (#6012). It comes from `getLockDb()`, a pool of
// its own. Taken from the service pool, `poolMax` purchases on different keys each held one service
// connection and then waited, inside their work, for another: no connection was left, postgres-js
// queues without a timeout, and every service query on the instance stalled with them.
// tests/integration/purchase-lock.test.ts runs a pool's worth of purchases (a pool of two) and fails
// on that stall. So the work must not call `withPurchaseLock` again: a nested call would wait on the
// lock pool the same way.
//
// THE KEYS, AND THE ORDER THEY NEST IN (ADR 0002 §10.2 F2; ADR 0004 D3). Two keys are taken:
//   - `org-plan:<org>`: the org-plan purchase — `createSubscriptionIntent` and `createCheckoutSession`
//     (app/server/actions/billing.ts, `withOrgPlanPurchaseKeys`) — and the operator's moved release
//     (scripts/payment-holds.ts);
//   - `ai:<org>`: the standalone AI purchase, `createAiSubscriptionIntent`, alone.
// No caller holds both keys. A lock and a purchase lease (lib/billing/purchase-lease.ts) nest in two
// places, in opposite orders, over different lease keys:
//   1. the org-plan purchase and its Checkout take `org-plan:<org>` HERE FIRST, and the `org-plan:<org>`
//      lease inside it, given back in reverse — the lease, then this lock (ADR 0004 O4, D3, C25). That is
//      for the rolling deploy: a pod before O4 takes this lock alone, and is excluded either way;
//   2. the moved release holds the hold's own lease and takes `org-plan:<T>` here inside it. It reaches
//      this lock only for a `new_org` hold — `decideMovedRelease` (lib/billing/payment-holds/machine.ts)
//      refuses before the lock unless the hold was opened by the link's refusal (row 1) and its payer is a
//      member of T (row 4), and an `org_plan` hold's payer is an org — so the lease it holds is a
//      `user:<payer>` one.
// So no cycle: the one caller that waits for a lease while holding this lock waits for an `org-plan:`
// one, and the one caller that waits for this lock while holding a lease holds a `user:` one. Every other
// taker of an `org-plan:` lease — the Pro trial, the hold sweeper (lib/billing/payment-holds/sweeper.ts,
// which never waits) and the operator script outside its moved release — never takes this lock.

import "server-only";
import { sql } from "drizzle-orm";
import { getLockDb } from "@/lib/db";
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
	return getLockDb().transaction(async (tx) => {
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
