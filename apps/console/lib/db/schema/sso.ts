// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth `@better-auth/sso` plugin table. SSO (OIDC + SAML) makes Alethia the
// Service Provider that consumes a customer's external IdP (Okta, Entra ID, AWS IAM
// Identity Center, …); the plugin itself ships in the enterprise package
// (@alethia/ee, via getAuthPlugins). Its table must live in the schema the core
// drizzleAdapter is given, so it's declared here — INERT in the community build (no
// sso plugin → never written). Field keys are camelCase to match Better Auth's
// adapter (the drizzle instance's casing: "snake_case" maps them to snake_case
// columns), ids are uuid. Providers can be scoped to an organization (per-org SSO).
//
// Best-effort match to @better-auth/sso's expected shape; reconcile against
// `npx @better-auth/cli generate` when standing the enterprise build up.

import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organizations";

export const ssoProvider = pgTable("sso_provider", {
	id: uuid().primaryKey().defaultRandom(),
	issuer: text().notNull(),
	domain: text().notNull(),
	providerId: text().notNull().unique(),
	oidcConfig: text(), // JSON — present for OIDC providers
	samlConfig: text(), // JSON — present for SAML providers
	userId: uuid()
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	// Per-organization SSO: null = instance-wide provider.
	organizationId: uuid().references(() => organization.id, {
		onDelete: "cascade",
	}),
	domainVerified: boolean().default(false).notNull(),
});

export type SsoProvider = typeof ssoProvider.$inferSelect;
