// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exactly-once bookkeeping for payment-provider webhooks. Providers retry and can duplicate
// deliveries; the state upsert is idempotent, but the branded emails are not — sending
// one per delivery would double-mail the customer. The handler claims each event id
// before doing work and marks it done/error after, so a replay of an already-done event
// is skipped. See app/api/webhooks/stripe/route.ts.
//
// Every function takes the `provider` whose event id it is: the ledger's key is
// (provider, event_id), so the same id string under two providers is two independent claims, and
// the advisory lock below is keyed on both so they never serialize against each other.

import { and, eq, sql } from "drizzle-orm";
import { type Db, getLockDb, getServiceDb, type Tx } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";

/** Outcome of claiming an event id for processing. */
export type ClaimResult =
	| { claimed: true }
	| { claimed: false; alreadyDone: boolean };

/** Outcome of a serialized exactly-once processing attempt (see {@link runWebhookEventExactlyOnce}). */
export type WebhookRunOutcome = "handled" | "skipped_done";

/** The ledger row for one provider's event id. */
function eventKey(provider: BillingProviderId, eventId: string) {
	return and(eq(stripeWebhookEvent.provider, provider), eq(stripeWebhookEvent.eventId, eventId));
}

/**
 * The advisory-lock key text for one provider's event id. `provider:eventId` — a provider id has no
 * colon, so two different (provider, id) pairs never produce the same text.
 */
export function webhookEventLockKey(provider: BillingProviderId, eventId: string): string {
	return `${provider}:${eventId}`;
}

/**
 * Claims a provider's event id for processing. Inserts a `processing` row; if the id
 * already exists it is NOT re-claimed and the caller learns whether it was already
 * `done` (skip entirely) or left `processing`/`error` (a prior attempt crashed —
 * Stripe is retrying, so let it run again). Idempotent on the event id PK.
 */
export async function claimWebhookEvent(
	provider: BillingProviderId,
	eventId: string,
	type: string,
): Promise<ClaimResult> {
	const inserted = await getServiceDb()
		.insert(stripeWebhookEvent)
		.values({ provider, eventId, type, status: "processing" })
		.onConflictDoNothing({ target: [stripeWebhookEvent.provider, stripeWebhookEvent.eventId] })
		.returning({ eventId: stripeWebhookEvent.eventId });

	if (inserted.length > 0) return { claimed: true };

	const [existing] = await getServiceDb()
		.select({ status: stripeWebhookEvent.status })
		.from(stripeWebhookEvent)
		.where(eventKey(provider, eventId))
		.limit(1);
	return { claimed: false, alreadyDone: existing?.status === "done" };
}

/**
 * Marks a claimed event as fully handled — replays of it are then skipped. Accepts an
 * explicit executor so the flip can run INSIDE the advisory-locked transaction (so "done"
 * becomes visible to a blocked concurrent delivery the instant the lock is released);
 * defaults to the service pool for standalone callers.
 */
export async function markWebhookEventDone(
	provider: BillingProviderId,
	eventId: string,
	exec: Db | Tx = getServiceDb(),
): Promise<void> {
	await exec
		.update(stripeWebhookEvent)
		.set({ status: "done", processedAt: new Date(), error: null })
		.where(eventKey(provider, eventId));
}

/**
 * Runs `handler` for a provider's event EXACTLY ONCE across concurrent / retried deliveries of the
 * same event id, then marks the row `done`. One transaction takes a per-event advisory lock
 * (`pg_advisory_xact_lock(hashtextextended('<provider>:<eventId>', 0))`) and holds it while `handler` runs; the
 * row re-read, the re-insert and the `done` mark run in that transaction, but the handler's own reads
 * and writes do not: they go through `getServiceDb()` and commit on their own. Deliveries of
 * the SAME id are serialized (different ids never block each other); the handler — which sends the
 * non-idempotent branded email — is invoked while the lock is held, so a second delivery blocks
 * until the first commits `done` and is then skipped.
 *
 * Under the lock the row status is re-read and the decision is explicit:
 *  - `done` → skip (idempotent, no email).
 *  - otherwise (our own fresh claim, OR a leftover `processing`/`error` row) → run the handler and
 *    mark `done`. Because the advisory lock is xact-scoped, a genuinely LIVE concurrent delivery is
 *    still holding the lock, so it blocks here and only proceeds once the winner has committed `done`
 *    (→ skipped). A row we find `processing` with the lock FREE therefore means the prior holder
 *    crashed/rolled back — re-running is exactly the right recovery, no lease heuristic needed.
 *
 * A throw from `handler` rolls back the `done` mark (the separately-committed claim row survives, so
 * the caller can flip it to `error` and 500 for a Stripe retry) and propagates to the caller.
 *
 * The transaction runs on a `getLockDb()` connection, not a service-pool one (#6027). Only the lock,
 * the row re-read, the re-insert and the `done` mark run in it; the handler's own reads and writes go
 * through `getServiceDb()` and commit on their own. Held on the service pool, `poolMax` deliveries of
 * different events each took a service connection and then waited, inside the handler, for another:
 * postgres-js queues without a timeout, so every service query on the instance stalled with them.
 * tests/integration/webhook-events-pool.test.ts runs a pool's worth of deliveries (a pool of two) and
 * fails on that stall. So the handler must not take a lock-pool connection itself (`withPurchaseLock`
 * or a nested delivery): it would wait on the lock pool the same way.
 *
 * @param provider Whose event id this is — half of the PK and of the advisory-lock key.
 * @param eventId The provider's event id (`evt_…`) — the other half of both.
 * @param eventType Event type, used only to re-establish a row deleted by a racing break-glass reset.
 * @param handler The side-effecting dispatch (e.g. `() => handleStripeEvent(event)`).
 */
export async function runWebhookEventExactlyOnce(
	provider: BillingProviderId,
	eventId: string,
	eventType: string,
	handler: () => Promise<void>,
): Promise<WebhookRunOutcome> {
	return getLockDb().transaction(async (tx): Promise<WebhookRunOutcome> => {
		// Serialize concurrent deliveries of THIS event id — auto-released at commit/rollback.
		// Different event ids hash to different keys, so they never block each other.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${webhookEventLockKey(provider, eventId)}, 0))`,
		);

		const [row] = await tx
			.select({ status: stripeWebhookEvent.status })
			.from(stripeWebhookEvent)
			.where(eventKey(provider, eventId))
			.limit(1);

		// Won by a delivery that took the lock first (or a completed prior run) — skip, no re-email.
		if (row?.status === "done") return "skipped_done";

		// Defensive: the claim row was deleted by a racing break-glass reset between claim and lock —
		// re-establish it so the done-mark below has a row to flip.
		if (!row) {
			await tx
				.insert(stripeWebhookEvent)
				.values({ provider, eventId, type: eventType, status: "processing" })
				.onConflictDoNothing({ target: [stripeWebhookEvent.provider, stripeWebhookEvent.eventId] });
		}

		// Run the handler while holding the lock; on success mark done in the SAME transaction so the
		// flip and the lock release are atomic. A throw here rolls back the mark and propagates.
		await handler();
		await markWebhookEventDone(provider, eventId, tx);
		return "handled";
	});
}

/**
 * Break-glass replay support: forget a stored event id so it can be re-dispatched. The exactly-once
 * guard short-circuits an already-`done` event, so a deliberate operator replay must first reset the
 * row. Deletes it (rather than flipping status) so the subsequent claim starts clean; a no-op if the
 * id was never seen. Returns whether a row existed. Used ONLY by the audited break-glass replay path.
 */
export async function resetWebhookEvent(
	provider: BillingProviderId,
	eventId: string,
): Promise<boolean> {
	const deleted = await getServiceDb()
		.delete(stripeWebhookEvent)
		.where(eventKey(provider, eventId))
		.returning({ eventId: stripeWebhookEvent.eventId });
	return deleted.length > 0;
}

/**
 * Marks a claimed event as failed (records the error, leaves it re-claimable). The
 * handler returns 500 so the provider retries the delivery.
 */
export async function markWebhookEventError(
	provider: BillingProviderId,
	eventId: string,
	error: string,
): Promise<void> {
	await getServiceDb()
		.update(stripeWebhookEvent)
		.set({ status: "error", processedAt: new Date(), error: error.slice(0, 1000) })
		.where(eventKey(provider, eventId));
}
