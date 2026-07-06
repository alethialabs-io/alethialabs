// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

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
		// Thread flavour: 'agent' = the infra agent (elench), 'support' = the support
		// assistant persona. Lets listThreads separate the two surfaces from one table.
		kind: text().default("agent").notNull(),
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

// Agent identity (elench) — a scoped, persistent agent modeled as DATA, not a
// standing process (Letta/MemGPT pattern): persona + mission + tool-scope + a
// memory namespace. A stateless executor reconstructs context per call. project_id
// NULL = an org-level agent. `memory_namespace` is the per-tenant prefix the memory
// store is keyed by (see lib/agent/memory-path.ts for the traversal guards).
export const agentIdentities = pgTable(
	"agent_identities",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		org_id: uuid(),
		project_id: uuid(),
		persona: text().notNull(),
		mission: text().notNull(),
		// Allowed tool names (registry audience is enforced separately at call time).
		tool_scope: jsonb().$type<string[]>().default([]).notNull(),
		memory_namespace: text().notNull(),
		version: integer().default(1).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_agent_identities_user").on(t.user_id),
		index("idx_agent_identities_org").on(t.org_id),
		index("idx_agent_identities_project").on(t.project_id),
	],
);

export type AgentIdentity = typeof agentIdentities.$inferSelect;
export type NewAgentIdentity = typeof agentIdentities.$inferInsert;

// Agent memory — semantic/episodic notes keyed by (namespace, path). The namespace
// is the tenant prefix from agentIdentities.memory_namespace; `path` is validated
// against traversal escapes (lib/agent/memory-path.ts) so one tenant can never read
// another's memory. pgvector is intentionally deferred (a rolling note + JSONB facts
// cover most value; add embeddings only when "have we seen this failure?" needs it).
export const agentMemory = pgTable(
	"agent_memory",
	{
		id: uuid().primaryKey().defaultRandom(),
		namespace: text().notNull(),
		path: text().notNull(),
		content: text().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [uniqueIndex("uq_agent_memory_ns_path").on(t.namespace, t.path)],
);

export type AgentMemory = typeof agentMemory.$inferSelect;
export type NewAgentMemory = typeof agentMemory.$inferInsert;
