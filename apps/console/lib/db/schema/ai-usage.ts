// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Append-only AI usage ledger — one row per metered AI action (a repo scan or an
// agent/Ask AI message), carrying the credits it cost and whether they came from the
// plan's included budget or purchased top-ups. Summed per window/week to enforce the
// credit budget. Owner-scoped (user_id + org_id) for the RLS backstop.
export const aiUsageLedger = pgTable(
	"ai_usage_ledger",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		org_id: uuid(),
		// "scan" | "agent".
		kind: text().notNull(),
		// Credits this action cost.
		credits: integer().default(0).notNull(),
		// "included" | "purchased" — which budget it drew from.
		source: text().default("included").notNull(),
		// jobId (scan) / threadId (agent), for traceability.
		ref_id: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_ai_usage_org_source_created").on(
			t.org_id,
			t.source,
			t.created_at,
		),
		index("idx_ai_usage_user").on(t.user_id),
	],
);

export type AiUsageRow = typeof aiUsageLedger.$inferSelect;
