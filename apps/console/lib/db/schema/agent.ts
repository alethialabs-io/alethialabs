// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import type { KnowledgeDoc } from "@/types/jsonb.types";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
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
		// ADR 0003 §4.2: the org this thread's turns bill to. From ADR 0003 slice 5 it is written once,
		// by the acceptance of the thread's first turn under the thread lock (`… WHERE billing_org_id
		// IS NULL`), and never changed. Nothing writes it yet (slice 1 adds the column only), so it is
		// NULL on every row until slice 5 lands; an existing thread is then pinned by its next turn.
		billing_org_id: uuid(),
		// ADR 0003 §4.2: the thread's revision. The default backfills every existing row with 1. Today
		// only `createThread` bumps it; `thread-transcript.ts`'s writes of `messages` do not yet,
		// and nothing checks a base revision. From slices 5 and 6, every statement that writes
		// `messages` bumps it in that same UPDATE and a write from a stale tab is refused.
		revision: integer().default(1).notNull(),
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

/** The lifecycle of one attempt's claim (ADR 0003 §5). */
export type TurnClaimState = "running" | "answered" | "failed" | "expired";

// A chat turn's claim (ADR 0003 §4.1): one row per ATTEMPT KEY of one turn of one thread, re-armed in
// place when a failed or expired attempt is retried. It is what makes a turn answered, and billed,
// exactly once: the route may call the model only after it holds the running claim.
//
// `thread_id` has NO foreign key, on purpose (§4.3): a claim outlives its thread's delete, so a late
// finalize is still decided by its `token` compare-and-set rather than by a cascade that erased which
// attempt owned the turn. Claims are removed only by the sweep's 30-day retention pass and by an
// acceptance that recreates a reaped thread id.
//
// RLS: `owner_only` in programmables.sql (`user_id = app.current_owner`, no org arm — the key carries
// no org, and a thread is its user's in every org). Acceptance, heartbeat and finalize run on the
// service role and name `user_id` explicitly; the policy governs the app-role reads.
export const agentTurnClaims = pgTable(
	"agent_turn_claims",
	{
		id: uuid().primaryKey().defaultRandom(),
		thread_id: uuid().notNull(),
		// The thread's owner; the RLS column.
		user_id: uuid().notNull(),
		// The user message id (client-minted; validated as 1-128 chars of [A-Za-z0-9_-] at the route).
		turn_id: text().notNull(),
		// `answer` · `regen:<answer id>` · `continue:<answer id>:<tool call ids>` (ADR 0003 §3).
		attempt_key: text().notNull(),
		state: text().$type<TurnClaimState>().notNull(),
		// Minted per attempt by the route; fences a late finalize or heartbeat.
		token: uuid().notNull(),
		// +1 each time a failed/expired row is re-armed.
		attempt_no: integer().default(1).notNull(),
		// A copy of the thread's pinned org at acceptance. Data, not visibility.
		billing_org_id: uuid().notNull(),
		// A copy of the thread's project, or NULL for an org thread.
		project_id: uuid(),
		// ai_usage_ledger.id of this attempt's hold; NULL without hosted billing.
		hold_id: uuid(),
		// The thread's revision after acceptance.
		accepted_revision: integer().notNull(),
		// Set together with `answered` (the check below).
		answer_id: text(),
		// The answer ended by abort or timeout.
		partial: boolean().default(false).notNull(),
		// A code, never model or user text.
		error: text(),
		// Silence bound: renewed to now() + 90 s by every heartbeat (ADR 0003 §8.2).
		lease_until: timestamp({ withTimezone: true }).notNull(),
		// The age bound of the heartbeat and the sweep: TURN_BUDGET_MS + 90 s from here (§8.2).
		accepted_at: timestamp({ withTimezone: true }).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		finished_at: timestamp({ withTimezone: true }),
	},
	(t) => [
		// One row per attempt key, re-armed in place.
		unique("uq_agent_turn_claims_key").on(t.thread_id, t.turn_id, t.attempt_key),
		// One running attempt per thread (ADR 0003 case 20).
		uniqueIndex("uq_agent_turn_claims_one_running")
			.on(t.thread_id)
			.where(sql`state = 'running'`),
		// The expiry sweep.
		index("idx_agent_turn_claims_lease")
			.on(t.lease_until)
			.where(sql`state = 'running'`),
		// The age pass's NOT EXISTS probe of a claimed hold.
		index("idx_agent_turn_claims_hold")
			.on(t.hold_id)
			.where(sql`state = 'running'`),
		// The retention pass.
		index("idx_agent_turn_claims_finished")
			.on(t.finished_at)
			.where(sql`state <> 'running'`),
		check(
			"agent_turn_claims_answered_has_answer",
			sql`(${t.state} = 'answered') = (${t.answer_id} IS NOT NULL)`,
		),
	],
);

export type AgentTurnClaim = typeof agentTurnClaims.$inferSelect;
export type NewAgentTurnClaim = typeof agentTurnClaims.$inferInsert;

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

// Per-message thumbs feedback (up/down) on an assistant turn. Owner-scoped (same owner_all
// RLS as agent_threads). A SEPARATE table rather than a field on the thread: saveThreadTranscript
// overwrites the whole `messages` JSONB every turn, which would clobber an inline feedback map.
// One row per (thread, message, owner); toggling the same value off deletes the row.
export const agentMessageFeedback = pgTable(
	"agent_message_feedback",
	{
		id: uuid().primaryKey().defaultRandom(),
		thread_id: uuid()
			.notNull()
			.references(() => agentThreads.id, { onDelete: "cascade" }),
		user_id: uuid().notNull(),
		// Owner scope (community org_id = user_id), backfilled by the set_org_id trigger.
		org_id: uuid(),
		// The AI SDK UIMessage id of the rated assistant message.
		message_id: text().notNull(),
		value: text().$type<"up" | "down">().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("uq_agent_message_feedback").on(
			t.thread_id,
			t.message_id,
			t.user_id,
		),
		index("idx_agent_message_feedback_thread").on(t.thread_id),
	],
);

export type AgentMessageFeedback = typeof agentMessageFeedback.$inferSelect;
export type NewAgentMessageFeedback = typeof agentMessageFeedback.$inferInsert;
