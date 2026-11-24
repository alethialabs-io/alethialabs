// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent surface's durable state (beta wave, spec agent-surface.md §4, seam AGT-S2 — the wave's
// only migration). Four tables:
//
//  1. apply_approvals     — a plan-bound, single-use, expiring approval for one DEPLOY or DESTROY
//                           (§4.3). `jobs.approval_id` points back at the one it was consumed by.
//  2. agent_oauth_grants  — what a user's MCP OAuth consent was narrowed to: scopes and projects
//                           (§4.4). Keyed by the consent row, one grant per consent.
//  3. org_agent_policy    — the org's agent toggles (§4.2): kill switch, no-agents-on-production,
//                           different approver, approval TTL, allowed OAuth clients.
//  4. agent_tool_calls    — one row per agent tool call (§4.5), with NO arguments.
//
// THIS FILE DECIDES NOTHING. It is the shape the approval engine (AGT-L1), the scope ceiling
// (AGT-L3) and the settings UI (AGT-L2) build on; no code reads or writes these yet. Row security
// lives in programmables.sql, with the other policies.
//
// `org_id` carries NO foreign key on any of them, for the reason cli_service_tokens.organization_id
// states: a community user's personal org is their profile id and has no `organization` row.

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
	actorCredential,
	agentScope,
	applyApprovalStatus,
	approvalOperation,
} from "./enums";
import { jobs } from "./jobs";
import { oauthClient, oauthConsent } from "./oauth";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

/**
 * An approval for ONE apply or destroy of ONE reviewed plan (spec §4.3).
 *
 * Created only against a succeeded PLAN job whose verify receipt carries `plan_sha256`; decided only
 * by a `session` actor; consumed with a compare-and-set on `consumed_at IS NULL` in the transaction
 * that inserts the job. The database holds the parts of that which a row can state: the digest is a
 * SHA-256 hex, `consumed` and `consumed_at` agree, a decision names its decider, and one approval
 * is consumed by at most one job (`uq_jobs_approval_id` on jobs). Who may decide, and when an
 * approval is superseded, are the engine's (AGT-L1).
 */
export const applyApprovals = pgTable(
	"apply_approvals",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		operation: approvalOperation().notNull(),
		/** The reviewed PLAN job (a destroy-mode plan for `destroy`). */
		plan_job_id: uuid()
			.notNull()
			.references((): AnyPgColumn => jobs.id, { onDelete: "cascade" }),
		/** The plan digest from that job's verify receipt; what the runner re-checks (seam S0). */
		plan_sha256: text().notNull(),
		/** The plan job's `configuration_hash`, so a moved design is visible without a join. */
		config_hash: text(),
		/** The person the requesting credential acts for. No FK, like `jobs.user_id`. */
		requester_user_id: uuid().notNull(),
		requester_credential: actorCredential().notNull(),
		/**
		 * The token id (service token), OAuth client id (agent_oauth) or conversation id (agent_in_app,
		 * lib/agent/in-app-credential.ts); null for the other kinds.
		 */
		requester_credential_ref: text(),
		/** The requester's note. UNTRUSTED text: rendered as such, never as an instruction. */
		reason: text(),
		status: applyApprovalStatus().notNull().default("pending"),
		approver_user_id: uuid(),
		/** The browser session that decided. No FK: sessions are deleted on sign-out and expiry. */
		approver_session_id: uuid(),
		decided_at: timestamp({ withTimezone: true }),
		/** Set at creation from the org's approval TTL (default 60 minutes, at most 24 hours). */
		expires_at: timestamp({ withTimezone: true }).notNull(),
		consumed_at: timestamp({ withTimezone: true }),
		consumed_job_id: uuid().references((): AnyPgColumn => jobs.id, {
			onDelete: "set null",
		}),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_apply_approvals_org").on(t.org_id, t.created_at),
		index("idx_apply_approvals_environment_status").on(
			t.environment_id,
			t.status,
		),
		index("idx_apply_approvals_plan_job").on(t.plan_job_id),
		// `request_apply` / `request_destroy` are idempotent on (plan job, requester) (spec §4.5): a
		// repeated request while one is live returns it instead of minting a second. The credential
		// ref is coalesced because two NULLs are distinct in a unique index.
		uniqueIndex("uq_apply_approvals_live_request")
			.on(
				t.plan_job_id,
				t.operation,
				t.requester_user_id,
				t.requester_credential,
				sql`coalesce("requester_credential_ref", '')`,
			)
			.where(sql`status IN ('pending', 'approved')`),
		check(
			"apply_approvals_plan_sha256_hex",
			sql`plan_sha256 ~ '^[0-9a-f]{64}$'`,
		),
		check(
			"apply_approvals_consumed_shape",
			sql`(status = 'consumed') = (consumed_at IS NOT NULL)`,
		),
		check(
			"apply_approvals_decision_shape",
			sql`status NOT IN ('approved', 'rejected', 'consumed') OR (approver_user_id IS NOT NULL AND decided_at IS NOT NULL)`,
		),
		check("apply_approvals_expiry_after_create", sql`expires_at > created_at`),
	],
);

/**
 * What a user's MCP OAuth consent was narrowed to (spec §4.4): the scope checklist and the project
 * picker on the consent page. One row per `oauth_consent` row, deleted with it. Effective permission
 * is the user's PDP grant ∩ these scopes ∩ these projects ∩ the org's agent policy (AGT-L3).
 */
export const agentOauthGrants = pgTable(
	"agent_oauth_grants",
	{
		id: uuid().primaryKey().defaultRandom(),
		consent_id: uuid()
			.notNull()
			.unique()
			.references(() => oauthConsent.id, { onDelete: "cascade" }),
		/** The org the grant was given in; the agent acts in this org only. */
		org_id: uuid().notNull(),
		user_id: uuid()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		client_id: text()
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		scopes: agentScope().array().notNull(),
		/** The projects the agent may touch. NULL means every project in the org, present and future. */
		project_ids: uuid().array(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/** Set on revoke; the row is kept for the audit trail. */
		revoked_at: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("idx_agent_oauth_grants_user").on(t.user_id, t.org_id),
		index("idx_agent_oauth_grants_client").on(t.client_id),
		check(
			"agent_oauth_grants_project_ids_nonempty",
			sql`project_ids IS NULL OR cardinality(project_ids) > 0`,
		),
	],
);

/**
 * The org's agent policy toggles (spec §4.2, §4.9). One row per org; a missing row means every
 * default below, which is today's behaviour. Core: the kill switch and no-agents-on-production.
 * Enterprise (ee/): a different approver and the OAuth client allow-list — the columns exist in
 * core so the migration chain does not fork by edition; the editions decide who may set them.
 */
export const orgAgentPolicy = pgTable(
	"org_agent_policy",
	{
		org_id: uuid().primaryKey(),
		/** The kill switch. Off refuses every agent credential in the org. */
		agent_access_enabled: boolean().notNull().default(true),
		/** On refuses an agent's apply or destroy to a `production` environment outright. */
		agents_may_not_apply_to_production: boolean().notNull().default(false),
		/** On requires the approver to be a different person from the requester (decision D6: off). */
		require_different_approver: boolean().notNull().default(false),
		/** How long an approval stays decidable (decision D6: 60 minutes; at most 24 hours). */
		approval_ttl_minutes: integer().notNull().default(60),
		/** OAuth client ids allowed to connect. NULL means any client. */
		allowed_oauth_client_ids: text().array(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/** Who last changed it. No FK: kept when that person is deleted. */
		updated_by: uuid(),
	},
	() => [
		check(
			"org_agent_policy_approval_ttl_range",
			sql`approval_ttl_minutes BETWEEN 1 AND 1440`,
		),
	],
);

/**
 * One row per agent tool call (spec §4.5): which tool, from which client and credential, how long
 * it took, how it failed, and what approval it produced. NO ARGUMENTS and no results are stored —
 * they can carry design content and log text. Kept in the control plane's own database, so a
 * self-hosted install keeps it local.
 */
export const agentToolCalls = pgTable(
	"agent_tool_calls",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		org_id: uuid().notNull(),
		/** The person the credential acts for. No FK, like `jobs.user_id`. */
		user_id: uuid().notNull(),
		tool: text().notNull(),
		/** The OAuth client id, when the credential is `agent_oauth`. */
		client_id: text(),
		credential: actorCredential().notNull(),
		latency_ms: integer().notNull(),
		/** A coarse error class; NULL when the call succeeded. Never an error message. */
		error_class: text(),
		approval_id: uuid().references(() => applyApprovals.id, {
			onDelete: "set null",
		}),
		/** The approval's status as the call returned it (e.g. `pending` from `request_apply`). */
		approval_status: applyApprovalStatus(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_agent_tool_calls_org").on(t.org_id, t.created_at),
		index("idx_agent_tool_calls_user").on(t.user_id, t.created_at),
		check("agent_tool_calls_latency_nonneg", sql`latency_ms >= 0`),
	],
);

export type ApplyApproval = typeof applyApprovals.$inferSelect;
export type NewApplyApproval = typeof applyApprovals.$inferInsert;
export type AgentOauthGrant = typeof agentOauthGrants.$inferSelect;
export type NewAgentOauthGrant = typeof agentOauthGrants.$inferInsert;
export type OrgAgentPolicy = typeof orgAgentPolicy.$inferSelect;
export type NewOrgAgentPolicy = typeof orgAgentPolicy.$inferInsert;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type NewAgentToolCall = typeof agentToolCalls.$inferInsert;
