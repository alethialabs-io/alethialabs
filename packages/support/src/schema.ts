// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Support cases — a tenant-owned help-desk. A case is owner-scoped (user_id + org_id,
// like agent_threads); org_id backfills to user_id via the set_org_id trigger for the
// community personal-org. Messages/attachments/reads are child tables whose tenancy
// flows through the parent case (RLS by subquery, like job_logs). Staff replies are
// written by the out-of-band ingest path via getServiceDb() (RLS-bypass), so customer
// RLS never has to permit staff — see the console's lib/db/programmables.sql (the
// console owns the DB + migrations; this schema is shared for query-building only).

import {
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import {
	supportAuthorType,
	supportCaseCategory,
	supportCaseSeverity,
	supportCaseStatus,
	supportCaseType,
} from "./enums";
import type {
	SupportAbuseDetails,
	SupportCaseContext,
	SupportContactPrefs,
} from "./types";

/**
 * A support case — the top-level help-desk record. `case_number` is a global monotonic
 * bigserial rendered as `CASE-000123` (decoupled from the UUID PK). `last_message_at` /
 * `last_author_type` are denormalized so the "My cases" list sorts without a join.
 */
export const supportCases = pgTable(
	"support_cases",
	{
		id: uuid().primaryKey().defaultRandom(),
		case_number: bigserial({ mode: "number" }).notNull(),
		user_id: uuid().notNull(),
		org_id: uuid(),
		type: supportCaseType().notNull(),
		category: supportCaseCategory().notNull(),
		severity: supportCaseSeverity().default("normal").notNull(),
		status: supportCaseStatus().default("open").notNull(),
		subject: text().notNull(),
		context: jsonb().$type<SupportCaseContext>().default({}).notNull(),
		contact: jsonb().$type<SupportContactPrefs>().notNull(),
		// Null unless type = 'abuse'.
		abuse: jsonb().$type<SupportAbuseDetails>(),
		// Staff assignee (no cross-DB FK; the user id / email of the assigned agent).
		assigned_staff_id: uuid(),
		last_message_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		last_author_type: supportAuthorType().default("customer").notNull(),
		resolved_at: timestamp({ withTimezone: true }),
		closed_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_support_cases_user").on(t.user_id),
		index("idx_support_cases_org").on(t.org_id),
		index("idx_support_cases_status").on(t.status),
		index("idx_support_cases_last_msg").on(t.last_message_at),
		uniqueIndex("uq_support_cases_number").on(t.case_number),
	],
);

/**
 * A thread message on a case (customer ↔ staff ↔ system/ai). `is_internal` staff notes
 * are never returned by the customer query builder (RLS is the tenancy wall, the query
 * is the visibility filter).
 */
export const supportMessages = pgTable(
	"support_messages",
	{
		id: uuid().primaryKey().defaultRandom(),
		case_id: uuid()
			.notNull()
			.references(() => supportCases.id, { onDelete: "cascade" }),
		author_type: supportAuthorType().notNull(),
		// The customer/staff user id; null for system/ai.
		author_id: uuid(),
		// Display-label snapshot (staff first name / "Alethia Support").
		author_name: text(),
		body: text().notNull(),
		// Staff-only note the customer never sees.
		is_internal: boolean().default(false).notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_support_messages_case").on(t.case_id, t.created_at)],
);

/** An S3-backed attachment bound to a case (optionally to a specific message). */
export const supportCaseAttachments = pgTable(
	"support_case_attachments",
	{
		id: uuid().primaryKey().defaultRandom(),
		case_id: uuid()
			.notNull()
			.references(() => supportCases.id, { onDelete: "cascade" }),
		message_id: uuid().references(() => supportMessages.id, {
			onDelete: "set null",
		}),
		uploaded_by: uuid().notNull(),
		file_name: text().notNull(),
		content_type: text().notNull(),
		size_bytes: integer().notNull(),
		// S3 object key: support/{orgId}/{caseId}/{attachmentId}/{fileName}.
		storage_key: text().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_support_attachments_case").on(t.case_id)],
);

/** Per-user last-read watermark, for unread badges (customer + staff). */
export const supportCaseReads = pgTable(
	"support_case_reads",
	{
		case_id: uuid()
			.notNull()
			.references(() => supportCases.id, { onDelete: "cascade" }),
		user_id: uuid().notNull(),
		last_read_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.case_id, t.user_id] })],
);

export type SupportCase = typeof supportCases.$inferSelect;
export type NewSupportCase = typeof supportCases.$inferInsert;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
export type SupportCaseAttachment = typeof supportCaseAttachments.$inferSelect;
export type NewSupportCaseAttachment =
	typeof supportCaseAttachments.$inferInsert;
export type SupportCaseRead = typeof supportCaseReads.$inferSelect;
