// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import type { KnowledgeDoc } from "@/types/jsonb.types";
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
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
		// NULL = an org-level conversation (the general agent). Set = a project-scoped
		// conversation (the project assistant), so its threads list/resume separately
		// from the org rail. Covered by the existing owner_all row policy (user/org).
		project_id: uuid(),
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
		index("idx_agent_threads_project").on(t.project_id),
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

// Elench context — the persistent KNOWLEDGE + CUSTOM INSTRUCTIONS that ride every chat in a
// scope. This is the Claude-Projects model: a project is a self-contained workspace whose
// instructions/knowledge are inherited by each of its chats and never leak out of it.
//   project_id NULL -> the ORG-level row: applies to the general (org) agent, and is layered
//                      UNDER every project's row (org policy first, project specifics second).
//   project_id set  -> that infra project's own row.
// The scope pair mirrors memoryNamespace(org, project?) 1:1 (lib/agent/memory-path.ts), so an
// agent's pinned context and its memory are keyed the same way.
export const agentContext = pgTable(
	"agent_context",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Owner scope (community org_id = user_id), matching the projects/artifacts RLS pattern.
		org_id: uuid(),
		project_id: uuid(),
		/** Custom instructions, e.g. "this env is PCI — always require approval before apply". */
		instructions: text().default("").notNull(),
		/**
		 * Pinned knowledge as NAMED DOCUMENTS — the analogue of the files in a Claude Project's
		 * knowledge base. Each rides every chat in this scope, so they're individually named and
		 * removable rather than one opaque blob.
		 */
		documents: jsonb().$type<KnowledgeDoc[]>().default([]).notNull(),
		/**
		 * @deprecated The original single free-text blob. Superseded by `documents` (migration
		 * backfilled any non-empty value into a "Notes" document). Kept so the column drop is a
		 * separate, reversible step — nothing reads it any more.
		 */
		notes: text().default("").notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// Exactly one row per (owner, scope). NULLS NOT DISTINCT so the org-level row
		// (project_id IS NULL) is unique too — Postgres otherwise treats every NULL as distinct
		// and would happily allow duplicate org rows.
		unique("uq_agent_context_scope")
			.on(t.org_id, t.project_id)
			.nullsNotDistinct(),
		index("idx_agent_context_org").on(t.org_id),
		index("idx_agent_context_project").on(t.project_id),
	],
);

export type AgentContext = typeof agentContext.$inferSelect;
export type NewAgentContext = typeof agentContext.$inferInsert;
