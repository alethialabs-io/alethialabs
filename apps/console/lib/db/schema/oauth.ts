// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth OIDC-provider tables, backing the mcp() plugin (B7). These let the
// console act as an OAuth 2.1 authorization server so remote MCP clients (Claude /
// claude.ai connectors) can register dynamically and obtain access tokens for the
// /api/mcp endpoint. Same camelCase-key + uuid-id conventions as auth.ts; the
// drizzle instance's casing: "snake_case" maps the keys to snake_case columns.

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

// A registered OAuth client. `clientId` is the Better-Auth-generated public id
// (text, not a uuid); access tokens + consents reference it by that value.
export const oauthApplication = pgTable("oauth_application", {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	icon: text(),
	metadata: text(),
	clientId: text().notNull().unique(),
	clientSecret: text(),
	redirectUrls: text().notNull(),
	type: text().notNull(),
	disabled: boolean().default(false),
	userId: uuid().references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// An issued access/refresh token pair scoped to a client + user.
export const oauthAccessToken = pgTable("oauth_access_token", {
	id: uuid().primaryKey().defaultRandom(),
	accessToken: text().notNull().unique(),
	refreshToken: text().notNull().unique(),
	accessTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
	refreshTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
	clientId: text().notNull(),
	userId: uuid().references(() => user.id, { onDelete: "cascade" }),
	scopes: text(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// A user's recorded consent decision for a client + scope set.
export const oauthConsent = pgTable("oauth_consent", {
	id: uuid().primaryKey().defaultRandom(),
	clientId: text().notNull(),
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	scopes: text(),
	consentGiven: boolean().notNull(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type OauthApplication = typeof oauthApplication.$inferSelect;
export type OauthAccessToken = typeof oauthAccessToken.$inferSelect;
export type OauthConsent = typeof oauthConsent.$inferSelect;
