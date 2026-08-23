// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth OAuth-provider tables, backing the mcp() plugin (B7). These let the console act as an
// OAuth 2.1 authorization server so remote MCP clients (Claude / claude.ai connectors) can register
// and obtain access tokens for the /api/mcp endpoint.
//
// ── These are NOT the tables that were here before ──
//
// Until 1.7 this file held `oauthApplication` / `oauthAccessToken` / `oauthConsent` — the model set
// of better-auth's in-core `oidcProvider` plugin. 1.7 REMOVED that plugin. `mcp()` is now
// `oauthProvider()` with an extra hook, so its models come from @better-auth/oauth-provider: a
// different schema that happens to share two table names. `oauthApplication` became `oauthClient`,
// `oauthAccessToken` kept its name but split its refresh half into a table of its own, and four
// more tables appeared. The plugin registers its whole schema unconditionally, so every model here
// must be a key in the adapter's `schema` map even where we never touch the feature — a missing one
// is a runtime `BetterAuthError: the model "x" was not found in the schema object`.
//
// ── Conventions ──
//
// Repo style, not the `auth generate` CLI's: camelCase keys with the drizzle instance's
// `casing: "snake_case"` doing the mapping, and `timestamp({ withTimezone: true })`. The CLI emits
// explicit snake_case literals and naive timestamps; both would be out of step with every other
// table here.
//
// Index NAMES are the canonical ones Better Auth derives from the model
// (`<modelName>_<fields>_<uidx|idx>`, camelCase model name). The drizzle adapter never looks them up
// at runtime, but matching them keeps a future `auth generate` diff clean and avoids the
// cross-table name-collision check tripping.
//
// FKs mostly target BUSINESS keys, not ids: `oauthClient.clientId` and `oauthResource.identifier`
// are text. `oauthAccessToken.refreshId` is the one exception that points at an `id`, so it is uuid.

import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { session, user } from "./auth";

/**
 * A registered OAuth client. `clientId` is the public, Better-Auth-generated id (text, not a uuid);
 * every other table references the client by that value rather than by the row id.
 *
 * `clientDiscoveryId` tags clients that arrived through CIMD (Client ID Metadata Documents), which
 * is how 1.7 replaced unauthenticated Dynamic Client Registration.
 */
export const oauthClient = pgTable(
	"oauth_client",
	{
		id: uuid().primaryKey().defaultRandom(),
		clientId: text().notNull().unique(),
		clientSecret: text(),
		clientDiscoveryId: text(),
		disabled: boolean().default(false),
		skipConsent: boolean(),
		enableEndSession: boolean(),
		subjectType: text(),
		scopes: text().array(),
		clientCredentialsScopes: text().array().default([]),
		userId: uuid().references(() => user.id),
		createdAt: timestamp({ withTimezone: true }).defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow(),
		name: text(),
		uri: text(),
		icon: text(),
		contacts: text().array(),
		tos: text(),
		policy: text(),
		softwareId: text(),
		softwareVersion: text(),
		softwareStatement: text(),
		redirectUris: text().array().notNull(),
		postLogoutRedirectUris: text().array(),
		backchannelLogoutUri: text(),
		backchannelLogoutSessionRequired: boolean(),
		tokenEndpointAuthMethod: text(),
		applicationType: text(),
		// The client's own JWKS (or a URI to it) for private_key_jwt auth. Not the `jwks` TABLE below,
		// which holds OUR signing keys.
		jwks: text(),
		jwksUri: text(),
		grantTypes: text().array(),
		responseTypes: text().array(),
		requirePKCE: boolean(),
		dpopBoundAccessTokens: boolean().default(false),
		referenceId: text(),
		metadata: jsonb(),
	},
	(t) => [index("oauthClient_userId_idx").on(t.userId)],
);

/**
 * A protected resource an access token can be bound to (RFC 8707). `mcp({ resource })` upserts its
 * own resource here on first use, which is why this table is reached even on a bare MCP setup.
 */
export const oauthResource = pgTable("oauth_resource", {
	id: uuid().primaryKey().defaultRandom(),
	identifier: text().notNull().unique(),
	name: text().notNull(),
	accessTokenTtl: integer(),
	refreshTokenTtl: integer(),
	signingAlgorithm: text(),
	signingKeyId: text(),
	allowedScopes: text().array(),
	customClaims: jsonb(),
	dpopBoundAccessTokensRequired: boolean().default(false),
	disabled: boolean().default(false),
	createdAt: timestamp({ withTimezone: true }).defaultNow(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow(),
	policyVersion: integer().default(1),
	metadata: jsonb(),
});

/**
 * Which clients may request which resources. The compound unique is load-bearing: the link endpoint
 * catches its violation and answers `alreadyLinked` rather than erroring.
 */
export const oauthClientResource = pgTable(
	"oauth_client_resource",
	{
		id: uuid().primaryKey().defaultRandom(),
		clientId: text()
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		resourceId: text()
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: "cascade" }),
		metadata: jsonb(),
		createdAt: timestamp({ withTimezone: true }).defaultNow(),
	},
	(t) => [
		uniqueIndex("oauthClientResource_clientId_resourceId_uidx").on(t.clientId, t.resourceId),
		index("oauthClientResource_clientId_idx").on(t.clientId),
		index("oauthClientResource_resourceId_idx").on(t.resourceId),
	],
);

/**
 * Refresh tokens, split out of the access-token table in 1.7 so rotation can be tracked per token.
 * `revoked` is a DATE (when), not a boolean.
 */
export const oauthRefreshToken = pgTable(
	"oauth_refresh_token",
	{
		id: uuid().primaryKey().defaultRandom(),
		token: text().notNull().unique(),
		clientId: text()
			.notNull()
			.references(() => oauthClient.clientId),
		sessionId: uuid().references(() => session.id, { onDelete: "set null" }),
		userId: uuid()
			.notNull()
			.references(() => user.id),
		referenceId: text(),
		authorizationCodeId: text(),
		resources: text().array(),
		requestedUserInfoClaims: text().array(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		revoked: timestamp({ withTimezone: true }),
		rotatedAt: timestamp({ withTimezone: true }),
		rotationReplayResponse: text(),
		rotationReplayExpiresAt: timestamp({ withTimezone: true }),
		authTime: timestamp({ withTimezone: true }),
		confirmation: jsonb(),
		scopes: text().array().notNull(),
	},
	(t) => [
		index("oauthRefreshToken_clientId_idx").on(t.clientId),
		index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
		index("oauthRefreshToken_userId_idx").on(t.userId),
		index("oauthRefreshToken_authorizationCodeId_idx").on(t.authorizationCodeId),
	],
);

/** An issued access token. `refreshId` is the one FK here that points at a row id rather than a business key. */
export const oauthAccessToken = pgTable(
	"oauth_access_token",
	{
		id: uuid().primaryKey().defaultRandom(),
		token: text().notNull().unique(),
		clientId: text()
			.notNull()
			.references(() => oauthClient.clientId),
		sessionId: uuid().references(() => session.id, { onDelete: "set null" }),
		userId: uuid().references(() => user.id),
		referenceId: text(),
		authorizationCodeId: text(),
		resources: text().array(),
		requestedUserInfoClaims: text().array(),
		refreshId: uuid().references(() => oauthRefreshToken.id),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		revoked: timestamp({ withTimezone: true }),
		confirmation: jsonb(),
		scopes: text().array().notNull(),
	},
	(t) => [
		index("oauthAccessToken_clientId_idx").on(t.clientId),
		index("oauthAccessToken_sessionId_idx").on(t.sessionId),
		index("oauthAccessToken_userId_idx").on(t.userId),
		index("oauthAccessToken_refreshId_idx").on(t.refreshId),
		index("oauthAccessToken_authorizationCodeId_idx").on(t.authorizationCodeId),
	],
);

/** A user's recorded consent for a client + scope set. 1.7 dropped `consentGiven`: a row IS the consent. */
export const oauthConsent = pgTable(
	"oauth_consent",
	{
		id: uuid().primaryKey().defaultRandom(),
		clientId: text()
			.notNull()
			.references(() => oauthClient.clientId),
		userId: uuid().references(() => user.id),
		referenceId: text(),
		resources: text().array(),
		requestedUserInfoClaims: text().array(),
		scopes: text().array().notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("oauthConsent_clientId_idx").on(t.clientId),
		index("oauthConsent_userId_idx").on(t.userId),
	],
);

/**
 * Replay protection for `private_key_jwt` client assertions: one row per consumed JTI.
 *
 * ⚠️ `id` is TEXT, deliberately, and must stay that way. Better Auth inserts a base64url-encoded
 * truncated SHA-256 digest here with `forceAllowId: true` — it is the JTI, not a generated id. With
 * this repo's `advanced.database.generateId: "uuid"`, `auth generate` emits `uuid("id")` for this
 * table; that passes every test we have and then fails in production with `invalid input syntax for
 * type uuid`, but only for a client using private_key_jwt auth.
 */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
	id: text().primaryKey(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
});

/**
 * The jwt() plugin's key store. Required, not optional: `getJwtPlugin()` throws when the plugin is
 * absent, and it is called from the token endpoint and the metadata document — the hot path, not
 * just OIDC. `alg` and `crv` are new in 1.7 so `oauthResource.signingAlgorithm` / `signingKeyId`
 * can select a key.
 */
export const jwks = pgTable("jwks", {
	id: uuid().primaryKey().defaultRandom(),
	publicKey: text().notNull(),
	privateKey: text().notNull(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	expiresAt: timestamp({ withTimezone: true }),
	alg: text(),
	crv: text(),
});

export type OauthClient = typeof oauthClient.$inferSelect;
export type OauthResource = typeof oauthResource.$inferSelect;
export type OauthClientResource = typeof oauthClientResource.$inferSelect;
export type OauthRefreshToken = typeof oauthRefreshToken.$inferSelect;
export type OauthAccessToken = typeof oauthAccessToken.$inferSelect;
export type OauthConsent = typeof oauthConsent.$inferSelect;
export type OauthClientAssertion = typeof oauthClientAssertion.$inferSelect;
export type Jwks = typeof jwks.$inferSelect;
