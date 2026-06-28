// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Agent chat thread — a persisted conversation with the Alethia agent. Owner-scoped
// (no cross-DB FK to auth.users). `messages` is the full AI SDK UIMessage[] transcript
// stored as JSONB; `org_id` mirrors the projects RLS pattern (community = user_id).
export const agentThreads = pgTable(
	"agent_threads",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		org_id: uuid(),
		title: text().notNull(),
		status: text().default("active").notNull(),
		messages: jsonb().$type<UIMessage[]>().default([]).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_agent_threads_user").on(t.user_id),
		index("idx_agent_threads_org").on(t.org_id),
	],
);

export type AgentThread = typeof agentThreads.$inferSelect;
export type NewAgentThread = typeof agentThreads.$inferInsert;
