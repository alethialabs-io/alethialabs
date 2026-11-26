// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only Drizzle references to the console-owned tables the staff app (apps/admin) reads.
//
// The console OWNS these tables and their migrations; nothing here generates or changes a migration.
// Each reference declares only the columns the staff app touches, named as the physical schema names
// them under the `snake_case` casing both apps configure.
//
// They live in this published package, not inside the staff app, for one reason: the staff app is
// moving to its own repository, and a console migration that renamed or dropped one of these columns
// would then break it in production with nothing in this repository noticing. The console's test
// `tests/db/console-refs-contract.test.ts` checks every column below against the console's real
// schema (it exists, has the same SQL type and, for an enum, the same values, and is NOT NULL wherever
// it is declared NOT NULL here), so that change fails CI here instead.
//
// Adding a column the staff app reads means adding it here; the contract test then holds the console
// to it.

import { bigint, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The console's `billing_plan` enum. Declared with the same name and values so the staff app reads a
 * typed value; the contract test holds the values equal to the console's, so a plan added or renamed
 * there fails CI before the staff app meets a value it does not know.
 */
export const billingPlan = pgEnum("billing_plan", ["community", "team", "enterprise"]);

/** The console's `billing_status` enum, held to the console's values the same way. */
export const billingStatus = pgEnum("billing_status", ["none", "trialing", "active", "past_due", "canceled"]);

/** Owning organization of a support case: name and slug for the staff list and detail. */
export const organization = pgTable("organization", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	slug: text().unique(),
	createdAt: timestamp({ withTimezone: true }),
});

/** A platform user: the case customer and, for `assigned_staff_id`, the staff assignee. */
export const user = pgTable("user", {
	id: uuid().primaryKey().defaultRandom(),
	name: text(),
	email: text().notNull().unique(),
});

/**
 * The AI usage ledger: one row per metered AI action, snapshotting the real USD cost of serving it in
 * `cost_micros` (1e-6 USD). Read for the staff AI-spend rollup.
 */
export const aiUsageLedger = pgTable("ai_usage_ledger", {
	id: uuid().primaryKey().defaultRandom(),
	user_id: uuid().notNull(),
	org_id: uuid(),
	kind: text().notNull(),
	credits: integer().notNull(),
	source: text().notNull(),
	model: text(),
	cost_micros: bigint({ mode: "number" }),
	created_at: timestamp({ withTimezone: true }).notNull(),
});

/**
 * The org billing record, the sole source of an org's plan. The staff app reads it for the org
 * detail and changes a plan only through the console's `set-plan` route, never by writing here, so
 * the console stays the single writer.
 */
export const organizationBilling = pgTable("organization_billing", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid().notNull().unique(),
	plan: billingPlan().notNull(),
	status: billingStatus().notNull(),
	stripeCustomerId: text(),
	stripeSubscriptionId: text(),
	paddleSubscriptionId: text(),
	seats: integer(),
	currentPeriodStart: timestamp({ withTimezone: true }),
	currentPeriodEnd: timestamp({ withTimezone: true }),
	welcomedAt: timestamp({ withTimezone: true }),
	updatedAt: timestamp({ withTimezone: true }),
});

/** Org membership: the staff app reads the member list and resolves the owner. */
export const member = pgTable("member", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid().notNull(),
	userId: uuid().notNull(),
	role: text().notNull(),
	createdAt: timestamp({ withTimezone: true }),
});
