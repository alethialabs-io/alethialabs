// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Local mirror of Paddle transactions — the Paddle counterpart of the `invoice` mirror. Paddle is
// the merchant of record, so the customer's invoice is PADDLE's document; this table is our record
// that a transaction exists, what it charged and where it stands, so the billing UI and the books
// never call Paddle at page load. One row per Paddle transaction (`paddle_transaction_id` unique →
// idempotent mirror: a replayed `transaction.*` webhook converges to the same row). Written only by
// the service role (the Paddle webhook, L3); members read their own org's rows (RLS in
// programmables.sql).

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";
import { organization } from "./organizations";

/** Paddle's transaction statuses (Paddle Billing API, `transaction.status`). */
export const PADDLE_TRANSACTION_STATUSES = [
	"draft",
	"ready",
	"billed",
	"paid",
	"completed",
	"canceled",
	"past_due",
] as const;

/** One of `PADDLE_TRANSACTION_STATUSES`. */
export type PaddleTransactionStatus = (typeof PADDLE_TRANSACTION_STATUSES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const paddleTransaction = pgTable(
	"paddle_transaction",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Paddle's transaction id (`txn_…`) — the mirror key. */
		paddleTransactionId: text().notNull().unique(),
		/** The subscription it belongs to (`sub_…`), when it is a renewal, an upgrade or a charge. */
		paddleSubscriptionId: text(),
		paddleCustomerId: text(),
		status: text().$type<PaddleTransactionStatus>().notNull(),
		/** Paddle's `origin` (web, subscription_recurring, subscription_charge, …), as given. */
		origin: text(),
		/** ISO 4217 code of the transaction's currency. */
		currency: text().notNull(),
		/** Amounts in the currency's minor unit, from Paddle's `details.totals`. */
		subtotalMinor: integer().notNull(),
		taxMinor: integer().notNull(),
		totalMinor: integer().notNull(),
		/** Paddle's invoice number once the transaction is billed/completed. */
		invoiceNumber: text(),
		/** The period this transaction bills, for a subscription transaction. */
		billingPeriodStart: timestamp({ withTimezone: true }),
		billingPeriodEnd: timestamp({ withTimezone: true }),
		billedAt: timestamp({ withTimezone: true }),
		/** When a refund / chargeback adjustment against this transaction was approved. */
		refundedAt: timestamp({ withTimezone: true }),
		chargebackAt: timestamp({ withTimezone: true }),
		/** What we put on the transaction when we created it (org, kind, plan). Typed; never loose. */
		customData: jsonb().$type<PaddleTransactionCustomData>(),
		/** Paddle's `occurred_at` of the newest event applied — the out-of-order watermark. */
		eventOccurredAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("paddle_transaction_org_idx").on(t.organizationId),
		index("paddle_transaction_subscription_idx").on(t.paddleSubscriptionId),
		check(
			"paddle_transaction_status_known",
			sql.raw(`status IN (${sqlList(PADDLE_TRANSACTION_STATUSES)})`),
		),
	],
);

export type PaddleTransaction = typeof paddleTransaction.$inferSelect;
export type PaddleTransactionInsert = typeof paddleTransaction.$inferInsert;
