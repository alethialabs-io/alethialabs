// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Purchased AI top-up credits (a one-time Stripe payment). A rollover balance spent
// only after the plan's included budget is exhausted. Balance =
// Σ(ai_credit_grant.credits) − Σ(ai_usage_ledger.credits where source = 'purchased').
// `stripe_ref` is the idempotency key (checkout session / payment intent id).
export const aiCreditGrant = pgTable(
	"ai_credit_grant",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid(),
		user_id: uuid().notNull(),
		credits: integer().notNull(),
		stripe_ref: text().unique(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_ai_credit_grant_org").on(t.org_id)],
);

export type AiCreditGrant = typeof aiCreditGrant.$inferSelect;
