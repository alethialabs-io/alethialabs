// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Early Access grant requests (#7321; the flow is EA-3).
//
// An EU business with a VAT number cannot be sold to yet, so it asks for a COMPLIMENTARY grant
// instead: its billing admin files one row here, the server checks the VAT number against VIES and
// stores what VIES said, and staff decide in the admin app. A grant is a plan set through the
// operator plane, never a Stripe object; this row is the record that the request was made, what
// VIES returned, and who decided what.
//
// States are text with check constraints, not pg enums: enums.ts is owned by other units.
//
// TENANCY (programmables.sql): RLS with an org-bounded SELECT and INSERT policy only. The org's own
// members can file and read their requests; nothing in the app role can UPDATE or DELETE one, so a
// request cannot mark itself granted or rewrite what VIES said. Staff decisions and the VIES result
// are written through the service role.

import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { user } from "./auth";
import { organization } from "./organizations";

/** The plans a complimentary grant can be asked for. */
export const EARLY_ACCESS_PLANS = ["team", "ai_plus", "ai_max"] as const;

/** One of `EARLY_ACCESS_PLANS`. */
export type EarlyAccessPlan = (typeof EARLY_ACCESS_PLANS)[number];

/**
 * A request's lifecycle. `open` until staff act; `granted` or `declined` is the decision;
 * `converted` means a granted organization later became a paying customer.
 */
export const EARLY_ACCESS_REQUEST_STATUSES = [
	"open",
	"granted",
	"declined",
	"converted",
] as const;

/** One of `EARLY_ACCESS_REQUEST_STATUSES`. */
export type EarlyAccessRequestStatus =
	(typeof EARLY_ACCESS_REQUEST_STATUSES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const earlyAccessRequest = pgTable(
	"early_access_request",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The billing admin who filed it. Kept as NULL, not deleted, if their account goes. */
		requestedByUserId: uuid().references(() => user.id, {
			onDelete: "set null",
		}),
		/** ISO 3166-1 alpha-2, upper-case, as declared on the request. */
		country: text().notNull(),
		/** The VAT number as the requester gave it. */
		vatId: text().notNull(),
		planWanted: text().$type<EarlyAccessPlan>().notNull(),
		status: text()
			.$type<EarlyAccessRequestStatus>()
			.default("open")
			.notNull(),
		/** The requester's optional note (for example, that the grant converts once billing opens). */
		requesterNote: text(),

		// ── VIES (TAX §3.3) ──────────────────────────────────────────────────────────────────────
		// All NULL means the number was NOT checked — VIES was unavailable — and the request is stored
		// "unchecked" rather than refused. `viesValid` is the answer only when `viesCheckedAt` is set.
		viesValid: boolean(),
		viesName: text(),
		viesAddress: text(),
		/** VIES's consultation number — the proof that this check happened. */
		viesRequestId: text(),
		viesCheckedAt: timestamp({ withTimezone: true }),

		// ── Staff decision (admin app, through the service role and withPlatformAudit) ──────────
		/** The staff member's email: platform staff are not console users (cf. platform_audit). */
		decidedByEmail: text(),
		decidedAt: timestamp({ withTimezone: true }),
		/** The reason staff gave for the last decision. */
		decisionReason: text(),

		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("early_access_request_org_idx").on(t.organizationId),
		index("early_access_request_status_idx").on(t.status),
		// One open request per organization: a second one waits for the first to be decided.
		uniqueIndex("early_access_request_one_open_per_org")
			.on(t.organizationId)
			.where(sql`status = 'open'`),
		check(
			"early_access_request_plan_known",
			sql.raw(`plan_wanted IN (${sqlList(EARLY_ACCESS_PLANS)})`),
		),
		check(
			"early_access_request_status_known",
			sql.raw(`status IN (${sqlList(EARLY_ACCESS_REQUEST_STATUSES)})`),
		),
		// A decided request says who decided it and when; an open one says neither.
		check(
			"early_access_request_decision_shape",
			sql`(status = 'open') = (decided_at IS NULL AND decided_by_email IS NULL)`,
		),
		// A VIES verdict exists only with the time it was obtained.
		check(
			"early_access_request_vies_shape",
			sql`vies_valid IS NULL OR vies_checked_at IS NOT NULL`,
		),
	],
);

export type EarlyAccessRequest = typeof earlyAccessRequest.$inferSelect;
export type EarlyAccessRequestInsert = typeof earlyAccessRequest.$inferInsert;

/** The text columns whose values are a closed list, narrowed from drizzle-zod's plain string. */
const closedLists = {
	planWanted: z.enum(EARLY_ACCESS_PLANS),
	status: z.enum(EARLY_ACCESS_REQUEST_STATUSES),
};

/** drizzle-zod validator for an `early_access_request` row as read. */
export const earlyAccessRequestSelectSchema = createSelectSchema(
	earlyAccessRequest,
	closedLists,
);

/** drizzle-zod validator for an `early_access_request` insert. */
export const earlyAccessRequestInsertSchema = createInsertSchema(
	earlyAccessRequest,
	{
		planWanted: closedLists.planWanted,
		status: closedLists.status.optional(),
	},
);
