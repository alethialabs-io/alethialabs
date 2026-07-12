// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Break-glass (privileged incident recovery) durable state. THE most security-sensitive surface
// in the platform: these actions bypass RLS, can act cross-tenant, and can force-destroy. Three
// tables back it, all reachable ONLY through the service role (getServiceDb) — RLS is enabled with
// no app policy (like cli_logins / runner_usage_sessions), so the least-privilege app role can
// neither read nor write them.
//
//  1. breakglass_session   — a time-boxed, audited operator session; every action references one.
//  2. breakglass_audit     — APPEND-ONLY, written BEFORE the action runs (so a failed action is
//                            still on the record). Immutability is enforced by a BEFORE UPDATE OR
//                            DELETE trigger (programmables.sql) that fires even for the service
//                            role — stronger than the RLS-only immutability of the customer audit_log.
//  3. breakglass_approval  — a single-use, TTL'd two-person approval token minted by a SECOND
//                            operator; a high-blast action consumes one bound to its exact
//                            action + resource + input hash.

import {
	bigint,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { BreakglassActionInput } from "@/types/jsonb.types";
import { breakglassAction, breakglassBlastRadius } from "./enums";

/**
 * A time-boxed break-glass session. An operator opens one (with a reason) before acting; it
 * expires after a short window (see lib/breakglass/config.ts). Opening a session is itself an
 * audited event (a breakglass_audit `open_session` row).
 */
export const breakglassSession = pgTable("breakglass_session", {
	id: uuid().primaryKey().defaultRandom(),
	// The operator's identity as resolved by the break-glass gate (CF-Access email or the CLI
	// bearer subject's account email), authorized against the BREAKGLASS_OPERATORS allowlist.
	operator_email: text().notNull(),
	reason: text().notNull(),
	opened_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	expires_at: timestamp({ withTimezone: true }).notNull(),
	// Set when the operator (or the TTL sweep) closes the session; a closed/expired session
	// can no longer authorize actions.
	closed_at: timestamp({ withTimezone: true }),
	// Best-effort request provenance for the forensic record.
	ip: text(),
	user_agent: text(),
});

/**
 * The immutable, append-only break-glass audit trail. One row is committed BEFORE every action
 * (`phase = 'attempt'`) and a second appended after (`phase = 'result'`, carrying outcome) — never
 * an UPDATE, so the table stays strictly append-only. See the immutability trigger in
 * programmables.sql. `input` is a small typed shape (types/jsonb.types.ts), never opaque JSON.
 */
export const breakglassAudit = pgTable(
	"breakglass_audit",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		// The session this action ran under. Null only for the `open_session` attempt row (the session
		// id is that row's own result) and for approval-mint rows. Deliberately a PLAIN uuid with NO
		// FK: a foreign key with an ON DELETE action would let deleting a session UPDATE this
		// append-only row (nulling session_id) — which the WORM trigger correctly blocks — so the
		// forensic log must not carry a mutating reference (same rationale as audit_log.user_id).
		session_id: uuid(),
		actor_email: text().notNull(),
		action: breakglassAction().notNull(),
		blast_radius: breakglassBlastRadius().notNull(),
		// The tenant/resource the action targeted. resource_type is a coarse label (job/env/runner/
		// state_lock/webhook/orphan); resource_id is the exact id the operator typed-confirmed.
		resource_type: text().notNull(),
		resource_id: text(),
		input: jsonb().$type<BreakglassActionInput>(),
		reason: text().notNull(),
		// The second operator who approved a high-blast action (null for low/none-blast actions).
		approver_email: text(),
		approval_id: uuid(),
		// 'attempt' (written before the act, committed) or 'result' (appended after).
		phase: text().notNull(),
		// On a 'result' row: 'ok' | 'error'. Null on an 'attempt' row.
		outcome: text(),
		detail: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_breakglass_audit_session").on(t.session_id),
		index("idx_breakglass_audit_created").on(t.created_at),
	],
);

/**
 * A single-use two-person approval token. A SECOND authorized operator mints one bound to the
 * EXACT action + resource + input hash of the high-blast action to be performed; the acting
 * operator presents its id, and the dispatcher consumes it (server-side) only if the approver
 * differs from the actor, it matches, and it is unexpired + unconsumed.
 */
export const breakglassApproval = pgTable(
	"breakglass_approval",
	{
		id: uuid().primaryKey().defaultRandom(),
		approver_email: text().notNull(),
		action: breakglassAction().notNull(),
		resource_type: text().notNull(),
		resource_id: text().notNull(),
		// sha256 of the canonicalized action input — binds the approval to the exact operation.
		input_hash: text().notNull(),
		reason: text().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		expires_at: timestamp({ withTimezone: true }).notNull(),
		// Set atomically when the approval is spent, with the acting operator's email.
		consumed_at: timestamp({ withTimezone: true }),
		consumed_by: text(),
	},
	(t) => [index("idx_breakglass_approval_lookup").on(t.action, t.resource_id)],
);

export type BreakglassSession = typeof breakglassSession.$inferSelect;
export type BreakglassAuditRow = typeof breakglassAudit.$inferSelect;
export type NewBreakglassAudit = typeof breakglassAudit.$inferInsert;
export type BreakglassApproval = typeof breakglassApproval.$inferSelect;
