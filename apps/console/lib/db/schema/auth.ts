// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth core tables (Phase D). Better Auth's Drizzle adapter indexes the
// schema by its canonical camelCase field names (expiresAt, userId, …), so the
// Drizzle property keys here are camelCase; the drizzle instance's
// casing: "snake_case" maps them to snake_case columns (expires_at, user_id, …).
// IDs are `uuid` (not Better Auth's default text) so user.id populates every
// `user_id uuid` column + the RLS backstop; the auth instance is configured with
// advanced.database.generateId = "uuid".

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	id: uuid().primaryKey().defaultRandom(),
	name: text(),
	email: text().notNull().unique(),
	emailVerified: boolean().default(false).notNull(),
	image: text(),
	// Provider handle captured at signup (GitHub/GitLab/Bitbucket `username`/`login`;
	// null for providers without one, e.g. Google). Seeds the auto-created org slug.
	username: text(),
	// When the user finished the post-signup /onboarding setup flow. NULL = not yet
	// onboarded (brand-new signups), which gates the post-login landing into /onboarding.
	// Pre-existing users are backfilled to created_at in programmables.sql.
	onboardingCompletedAt: timestamp({ withTimezone: true }),
	// When the account consumed its single, account-wide Pro trial. NULL = the trial is
	// still available (the getProOffer hook offers it on /onboarding + the create-org
	// sheet); set the first time startProTrial succeeds so it can never be farmed. Bound
	// to the user (not the org) so spinning up extra orgs grants no extra trials.
	proTrialConsumedAt: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const session = pgTable("session", {
	id: uuid().primaryKey().defaultRandom(),
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	token: text().notNull().unique(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	ipAddress: text(),
	userAgent: text(),
	// Set by the enterprise organization plugin on org-switch; null in community.
	activeOrganizationId: uuid(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// One row per linked social account; carries the provider OAuth tokens that the
// dedicated provider_tokens table used to hold (Phase D full consolidation).
export const account = pgTable("account", {
	id: uuid().primaryKey().defaultRandom(),
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accountId: text().notNull(),
	providerId: text().notNull(),
	accessToken: text(),
	refreshToken: text(),
	idToken: text(),
	accessTokenExpiresAt: timestamp({ withTimezone: true }),
	refreshTokenExpiresAt: timestamp({ withTimezone: true }),
	scope: text(),
	password: text(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// Email-OTP codes + other short-lived verification values live here.
export const verification = pgTable("verification", {
	id: uuid().primaryKey().defaultRandom(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Verification = typeof verification.$inferSelect;
