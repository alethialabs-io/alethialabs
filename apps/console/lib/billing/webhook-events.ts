// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exactly-once bookkeeping for the Stripe webhook. Stripe retries and can duplicate
// deliveries; the state upsert is idempotent, but the branded emails are not — sending
// one per delivery would double-mail the customer. The handler claims each event id
// before doing work and marks it done/error after, so a replay of an already-done event
// is skipped. See app/api/webhooks/stripe/route.ts.

import { eq, sql } from "drizzle-orm";
import { type Db, getServiceDb, type Tx } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";

/** Outcome of claiming an event id for processing. */
export type ClaimResult =
	| { claimed: true }
	| { claimed: false; alreadyDone: boolean };

/** Outcome of a serialized exactly-once processing attempt (see {@link runWebhookEventExactlyOnce}). */
export type WebhookRunOutcome = "handled" | "skipped_done";

/**
 * Claims a Stripe event id for processing. Inserts a `processing` row; if the id
 * already exists it is NOT re-claimed and the caller learns whether it was already
 * `done` (skip entirely) or left `processing`/`error` (a prior attempt crashed —
 * Stripe is retrying, so let it run again). Idempotent on the event id PK.
 */
export async function claimWebhookEvent(
	eventId: string,
	type: string,
): Promise<ClaimResult> {
	const inserted = await getServiceDb()
		.insert(stripeWebhookEvent)
		.values({ eventId, type, status: "processing" })
		.onConflictDoNothing({ target: stripeWebhookEvent.eventId })
		.returning({ eventId: stripeWebhookEvent.eventId });

	if (inserted.length > 0) return { claimed: true };

	const [existing] = await getServiceDb()
		.select({ status: stripeWebhookEvent.status })
		.from(stripeWebhookEvent)
		.where(eq(stripeWebhookEvent.eventId, eventId))
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
	eventId: string,
	exec: Db | Tx = getServiceDb(),
): Promise<void> {
	await exec
		.update(stripeWebhookEvent)
		.set({ status: "done", processedAt: new Date(), error: null })
		.where(eq(stripeWebhookEvent.eventId, eventId));
}

/**
 * Runs `handler` for a Stripe event EXACTLY ONCE across concurrent / retried deliveries of the
 * same event id, then marks the row `done` — all inside a single transaction that first takes a
 * per-event advisory lock (`pg_advisory_xact_lock(hashtextextended(eventId, 0))`). Deliveries of
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
 * @param eventId Stripe event id (`evt_…`) — the PK and the advisory-lock key.
 * @param eventType Event type, used only to re-establish a row deleted by a racing break-glass reset.
 * @param handler The side-effecting dispatch (e.g. `() => handleStripeEvent(event)`).
 */
export async function runWebhookEventExactlyOnce(
	eventId: string,
	eventType: string,
	handler: () => Promise<void>,
): Promise<WebhookRunOutcome> {
	return getServiceDb().transaction(async (tx): Promise<WebhookRunOutcome> => {
		// Serialize concurrent deliveries of THIS event id — auto-released at commit/rollback.
		// Different event ids hash to different keys, so they never block each other.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${eventId}, 0))`,
		);

		const [row] = await tx
			.select({ status: stripeWebhookEvent.status })
			.from(stripeWebhookEvent)
			.where(eq(stripeWebhookEvent.eventId, eventId))
			.limit(1);

		// Won by a delivery that took the lock first (or a completed prior run) — skip, no re-email.
		if (row?.status === "done") return "skipped_done";

		// Defensive: the claim row was deleted by a racing break-glass reset between claim and lock —
		// re-establish it so the done-mark below has a row to flip.
		if (!row) {
			await tx
				.insert(stripeWebhookEvent)
				.values({ eventId, type: eventType, status: "processing" })
				.onConflictDoNothing({ target: stripeWebhookEvent.eventId });
		}

		// Run the handler while holding the lock; on success mark done in the SAME transaction so the
		// flip and the lock release are atomic. A throw here rolls back the mark and propagates.
		await handler();
		await markWebhookEventDone(eventId, tx);
		return "handled";
	});
}

/**
 * Break-glass replay support: forget a stored event id so it can be re-dispatched. The exactly-once
 * guard short-circuits an already-`done` event, so a deliberate operator replay must first reset the
 * row. Deletes it (rather than flipping status) so the subsequent claim starts clean; a no-op if the
 * id was never seen. Returns whether a row existed. Used ONLY by the audited break-glass replay path.
 */
export async function resetWebhookEvent(eventId: string): Promise<boolean> {
	const deleted = await getServiceDb()
		.delete(stripeWebhookEvent)
		.where(eq(stripeWebhookEvent.eventId, eventId))
		.returning({ eventId: stripeWebhookEvent.eventId });
	return deleted.length > 0;
}

/**
 * Marks a claimed event as failed (records the error, leaves it re-claimable). The
 * handler returns 500 so Stripe retries the delivery.
 */
export async function markWebhookEventError(
	eventId: string,
	error: string,
): Promise<void> {
	await getServiceDb()
		.update(stripeWebhookEvent)
		.set({ status: "error", processedAt: new Date(), error: error.slice(0, 1000) })
		.where(eq(stripeWebhookEvent.eventId, eventId));
}
