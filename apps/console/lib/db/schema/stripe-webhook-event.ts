// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ledger of processed payment-provider webhook events — the exactly-once guard for the
// webhook's SIDE EFFECTS (branded receipt/dunning emails). State upserts are already
// idempotent on organization_id, but providers retry/duplicate events, and sending an
// email per delivery would double-mail the customer. The handler claims each event id
// here (PK insert) before doing work: a second delivery of the same id sees a `done`
// row and returns 200 without re-sending. Written by app/api/webhooks/stripe, and by
// billing.ts `confirmCardSaved`, which claims a SetupIntent id (`seti_…`, type
// `setup_intent.recorded`) so a saved card is recorded in the Activity log exactly once.
//
// The table keeps its historical name (no rename: drizzle-kit would prompt, and every reader
// would move with it) but is no longer Stripe-only: `provider` says whose event id a row holds,
// and the primary key is (provider, event_id), so the same id string from two providers is two
// independent claims. Existing rows are Stripe's (the column defaults to `stripe`).

import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { type BillingProviderId, billingProviderSqlList } from "./billing-provider";

// processing = claimed, work in flight; done = fully handled (skip replays);
// error = handler threw (the provider will retry — the row is re-claimable).
export const stripeWebhookEventStatus = pgEnum("stripe_webhook_event_status", [
	"processing",
	"done",
	"error",
]);

export const stripeWebhookEvent = pgTable(
	"stripe_webhook_event",
	{
		// Whose event this is. Part of the PK, so a Stripe `evt_…` and a Paddle `evt_…` never collide.
		provider: text().$type<BillingProviderId>().default("stripe").notNull(),
		// The provider's event id (Stripe `evt_…`, Paddle `evt_…`), or a Stripe SetupIntent id
		// (`seti_…`). With `provider`, the PK that makes the claim insert idempotent.
		eventId: text().notNull(),
		// The event type (e.g. invoice.payment_succeeded), kept for audit/debugging.
		type: text().notNull(),
		status: stripeWebhookEventStatus().default("processing").notNull(),
		// Last error message when status = error (null otherwise).
		error: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// Set when the handler finishes (done or error).
		processedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.provider, t.eventId] }),
		check(
			"stripe_webhook_event_provider_known",
			sql.raw(`provider IN (${billingProviderSqlList()})`),
		),
	],
);

export type StripeWebhookEvent = typeof stripeWebhookEvent.$inferSelect;
export type StripeWebhookEventInsert = typeof stripeWebhookEvent.$inferInsert;
