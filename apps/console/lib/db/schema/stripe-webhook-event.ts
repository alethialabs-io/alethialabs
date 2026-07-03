// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ledger of processed Stripe webhook events — the exactly-once guard for the
// webhook's SIDE EFFECTS (branded receipt/dunning emails). State upserts are already
// idempotent on organization_id, but Stripe retries/duplicates events, and sending an
// email per delivery would double-mail the customer. The handler claims each event id
// here (PK insert) before doing work: a second delivery of the same id sees a `done`
// row and returns 200 without re-sending. Written only by app/api/webhooks/stripe.

import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// processing = claimed, work in flight; done = fully handled (skip replays);
// error = handler threw (Stripe will retry — the row is re-claimable).
export const stripeWebhookEventStatus = pgEnum("stripe_webhook_event_status", [
	"processing",
	"done",
	"error",
]);

export const stripeWebhookEvent = pgTable("stripe_webhook_event", {
	// Stripe's event id (evt_…) — PK makes the claim insert idempotent.
	eventId: text().primaryKey(),
	// The event type (e.g. invoice.payment_succeeded), kept for audit/debugging.
	type: text().notNull(),
	status: stripeWebhookEventStatus().default("processing").notNull(),
	// Last error message when status = error (null otherwise).
	error: text(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	// Set when the handler finishes (done or error).
	processedAt: timestamp({ withTimezone: true }),
});

export type StripeWebhookEvent = typeof stripeWebhookEvent.$inferSelect;
export type StripeWebhookEventInsert = typeof stripeWebhookEvent.$inferInsert;
