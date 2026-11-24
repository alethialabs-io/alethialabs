// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Purchased AI top-up credits (a one-time Stripe or Paddle payment). A rollover balance spent
// only after the plan's included budget is exhausted. Balance =
// Σ(ai_credit_grant.credits) − Σ(ai_usage_ledger.credits where source = 'purchased').
// The provider reference is the idempotency key: `stripe_ref` (checkout session / payment intent
// id) for a Stripe purchase, `paddle_transaction_id` (`txn_…`) for a Paddle one. Each is unique,
// and a grant carries at most one of them (check below) — a grant paid twice is two grants.
export const aiCreditGrant = pgTable(
	"ai_credit_grant",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid(),
		user_id: uuid().notNull(),
		credits: integer().notNull(),
		stripe_ref: text().unique(),
		paddle_transaction_id: text().unique(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_ai_credit_grant_org").on(t.org_id),
		check(
			"ai_credit_grant_at_most_one_ref",
			sql`num_nonnulls(stripe_ref, paddle_transaction_id) <= 1`,
		),
	],
);

export type AiCreditGrant = typeof aiCreditGrant.$inferSelect;
