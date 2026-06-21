// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth `organization` plugin tables. The plugin itself ships in the
// enterprise package (@alethia/ee, via getAuthPlugins) — but its tables must live
// in the schema the core drizzleAdapter is given, so they're declared here. They
// are INERT in the community build (no organization plugin → never written); a
// user's tenancy stays their personal org (org_id == user.id). Field keys are
// camelCase to match Better Auth's adapter (the drizzle instance's
// casing: "snake_case" maps them to snake_case columns), ids are uuid.
//
// Best-effort match to better-auth 1.6.19's expected shape; reconcile against
// `npx @better-auth/cli generate` when standing the enterprise build up.

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const organization = pgTable("organization", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	slug: text().unique(),
	logo: text(),
	metadata: text(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const member = pgTable("member", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid()
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	role: text().default("member").notNull(),
	// 'active' | 'suspended'. Suspending keeps the member row + role but revokes the
	// PDP grant (no access); reactivating restores it. Drives the Members status column.
	status: text().default("active").notNull(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const invitation = pgTable("invitation", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid()
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	email: text().notNull(),
	role: text(),
	status: text().default("pending").notNull(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	inviterId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Organization = typeof organization.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Invitation = typeof invitation.$inferSelect;
