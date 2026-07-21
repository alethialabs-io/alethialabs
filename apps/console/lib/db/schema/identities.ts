// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AzureCachedResources,
	CachedResources,
	CloudCredentials,
	ConnectorCredentials,
	GcpCachedResources,
} from "@/types/jsonb.types";
import { connectors } from "./connectors";
import { cloudIdentityStatus, cloudProvider, credentialScope } from "./enums";

// Cloud credential anchors. `credentials`/`cached_resources` are typed JSONB.
export const cloudIdentities = pgTable(
	"cloud_identities",
	{
		id: uuid().primaryKey().defaultRandom(),
		// The author of the credential (the user who connected it).
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		// Visibility: personal (author-only) or org (shared with the org per PDP role).
		scope: credentialScope().default("personal").notNull(),
		provider: cloudProvider().notNull(),
		name: text().default("My Cloud Account").notNull(),
		credentials: jsonb().$type<CloudCredentials>().default({}).notNull(),
		cached_resources: jsonb().$type<
			CachedResources | GcpCachedResources | AzureCachedResources
		>(),
		cached_at: timestamp({ withTimezone: true }),
		is_verified: boolean().default(false),
		// Richer connection lifecycle (the verification finalize / page health drive
		// off this). `connected` ⇔ `is_verified=true`; both are set together.
		status: cloudIdentityStatus().default("pending").notNull(),
		// Last health-probe failure reason (cleared on a successful verify).
		last_error: text(),
		// When the most recent health probe resolved (success or failure).
		last_tested_at: timestamp({ withTimezone: true }),
		// The cloud account / principal the server-side probe authenticated as (proof of access).
		verified_account_id: text(),
		// Provisioning permissions the probe found MISSING (drives the `degraded` status). Empty when
		// fully capable; the connectors UI lists these so the user can widen the role.
		missing_permissions: text().array().default([]),
		// When the server-side asset inventory for this connection last completed a full sweep.
		inventory_synced_at: timestamp({ withTimezone: true }),
		// When the per-tenant capabilities catalog (regions/instance-types) last completed a full sweep
		// for this connection (epic #928). Doubles as the change-detection DIRTY SENTINEL: an
		// invalidation event NULLs it so the next sweep tick treats the slice as due (no extra column).
		capabilities_synced_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_cloud_identities_user").on(t.user_id),
		index("idx_cloud_identities_org").on(t.org_id),
	],
);

// Git OAuth tokens were retired into Better Auth's `account` table in Phase D
// (the provider_tokens table is dropped). The gitProvider enum lives on in
// enums.ts — its GitProvider type still names the git providers app-wide.

// api_key credential anchor for pluggable per-category connectors (Cloudflare,
// Vault, Docker Hub, Datadog, …) — the analogue of cloud_identities (cloud) and
// Better Auth `account` (git). Secret fields in `credentials` are encrypted at
// rest (lib/crypto/secrets.ts); non-secret fields are plaintext. RLS-scoped like
// cloud_identities (owner_all in programmables.sql).
export const connectorCredentials = pgTable(
	"connector_credentials",
	{
		id: uuid().primaryKey().defaultRandom(),
		// The author of the credential (the user who connected it).
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		// Visibility: personal (author-only) or org (shared with the org per PDP role).
		scope: credentialScope().default("personal").notNull(),
		connector_id: uuid()
			.notNull()
			.references(() => connectors.id, { onDelete: "cascade" }),
		credentials: jsonb().$type<ConnectorCredentials>().default({}).notNull(),
		is_verified: boolean().default(false),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// One personal credential per author per connector …
		uniqueIndex("connector_credentials_personal_key")
			.on(t.user_id, t.connector_id)
			.where(sql`scope = 'personal'`),
		// … and one shared credential per org per connector.
		uniqueIndex("connector_credentials_org_key")
			.on(t.org_id, t.connector_id)
			.where(sql`scope = 'org'`),
		index("idx_connector_credentials_user").on(t.user_id),
		index("idx_connector_credentials_org").on(t.org_id),
	],
);

export type CloudIdentity = typeof cloudIdentities.$inferSelect;
export type NewCloudIdentity = typeof cloudIdentities.$inferInsert;
export type ConnectorCredential = typeof connectorCredentials.$inferSelect;
export type NewConnectorCredential = typeof connectorCredentials.$inferInsert;
