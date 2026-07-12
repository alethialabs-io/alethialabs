// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exactly-once bookkeeping for the Stripe webhook. Stripe retries and can duplicate
// deliveries; the state upsert is idempotent, but the branded emails are not — sending
// one per delivery would double-mail the customer. The handler claims each event id
// before doing work and marks it done/error after, so a replay of an already-done event
// is skipped. See app/api/webhooks/stripe/route.ts.

import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { stripeWebhookEvent } from "@/lib/db/schema";

/** Outcome of claiming an event id for processing. */
export type ClaimResult =
	| { claimed: true }
	| { claimed: false; alreadyDone: boolean };

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

/** Marks a claimed event as fully handled — replays of it are then skipped. */
export async function markWebhookEventDone(eventId: string): Promise<void> {
	await getServiceDb()
		.update(stripeWebhookEvent)
		.set({ status: "done", processedAt: new Date(), error: null })
		.where(eq(stripeWebhookEvent.eventId, eventId));
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
