// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The platform-operator schema — the Enterprise contract record and the append-only audit of every
// operator mutation. Owned by this package and shared with the staff app (apps/admin), which holds
// ALL the operator logic; the console re-exports this only so its single drizzle-kit migrator
// creates the tables (see apps/console/lib/db/schema/platform.ts). The console never reads them.
//
// Deliberately self-contained: no imports from the console (no `organization` FK, no billing enums),
// mirroring @repo/support. `plan`/`currency` are text, validated in the operator app.

import {
	bigint,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { platformCollectionMethod } from "./enums";
import type { PlatformAuditInput } from "./types";

// Re-exported so the console's schema barrel (which drizzle-kit scans) SEES the pgEnum and emits
// its CREATE TYPE. Without this the generated migration references the type but never creates it.
export { platformCollectionMethod } from "./enums";

/**
 * The Enterprise contract an operator recorded for an org: what was agreed, for how long, how it's
 * paid, and the external refs. Drives the org-detail contract history and (via `term_end`) the
 * off-Stripe lapse the console already enforces in `isManualGrantExpired`.
 *
 * NO foreign key to `organization` — this package can't import the console's tables, and a business
 * /forensic record shouldn't be cascade-deleted with the org it describes (same rationale as
 * breakglass_audit). Referential integrity is enforced by the operator flow.
 */
export const enterpriseContract = pgTable(
	"enterprise_contract",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid().notNull(),
		plan: text().notNull(),
		seats: bigint({ mode: "number" }),
		termStart: timestamp({ withTimezone: true }).notNull(),
		/** null = open-ended (never lapses). */
		termEnd: timestamp({ withTimezone: true }),
		collectionMethod: platformCollectionMethod().notNull(),
		amountCents: bigint({ mode: "number" }),
		currency: text().default("usd").notNull(),
		/** The signed contract / MSA reference. */
		contractRef: text(),
		/** Stripe invoice id, Odoo фактура number, or a bank reference. */
		invoiceRef: text(),
		notes: text(),
		/** Set when collection_method = 'stripe', so the operator can trace the Stripe objects. */
		stripeCustomerId: text(),
		stripeSubscriptionId: text(),
		createdByEmail: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		revokedAt: timestamp({ withTimezone: true }),
		revokedByEmail: text(),
	},
	(t) => [
		index("idx_enterprise_contract_org").on(t.organizationId),
		index("idx_enterprise_contract_term_end").on(t.termEnd),
	],
);

/**
 * Append-only WORM audit of every platform-operator mutation. One row is committed BEFORE the act
 * (`phase='attempt'`, so a mutation that crashes mid-flight is still on record) and a second after
 * (`phase='result'` with the outcome) — never an UPDATE. `reason` is REQUIRED.
 *
 * Immutability is enforced by a BEFORE UPDATE OR DELETE / TRUNCATE trigger in the console's
 * programmables.sql (copied from breakglass_audit) — triggers are NOT bypassed by BYPASSRLS, so the
 * row is immutable even to the service role that writes it. Like `enterprise_contract`, it carries
 * no FK: an ON DELETE action would trip that trigger and jam the parent delete.
 */
export const platformAudit = pgTable(
	"platform_audit",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		actorEmail: text().notNull(),
		/** grant_enterprise | create_enterprise_org | revoke_contract | … */
		action: text().notNull(),
		/** null only on a create-org attempt (the org id is the result). */
		targetOrgId: uuid(),
		input: jsonb().$type<PlatformAuditInput>(),
		reason: text().notNull(),
		/** 'attempt' | 'result' */
		phase: text().notNull(),
		/** 'ok' | 'error' — null on an attempt row. */
		outcome: text(),
		detail: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_platform_audit_org").on(t.targetOrgId),
		index("idx_platform_audit_created").on(t.createdAt),
	],
);

export type EnterpriseContract = typeof enterpriseContract.$inferSelect;
export type NewEnterpriseContract = typeof enterpriseContract.$inferInsert;
export type PlatformAuditRow = typeof platformAudit.$inferSelect;
export type NewPlatformAudit = typeof platformAudit.$inferInsert;
