// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AzureCachedResources,
	CachedResources,
	CloudCredentials,
	GcpCachedResources,
} from "@/types/database-custom.types";
import { cloudProvider, gitProvider } from "./enums";

// Cloud credential anchors. `credentials`/`cached_resources` are typed JSONB.
export const cloudIdentities = pgTable(
	"cloud_identities",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		provider: cloudProvider().notNull(),
		name: text().default("My Cloud Account").notNull(),
		credentials: jsonb().$type<CloudCredentials>().default({}).notNull(),
		cached_resources: jsonb().$type<
			CachedResources | GcpCachedResources | AzureCachedResources
		>(),
		cached_at: timestamp({ withTimezone: true }),
		is_verified: boolean().default(false),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_cloud_identities_user").on(t.user_id)],
);

// Git OAuth tokens (retired into Better Auth's `account` table in Phase D).
export const providerTokens = pgTable(
	"provider_tokens",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		provider: gitProvider().notNull(),
		access_token: text().notNull(),
		refresh_token: text(),
		expires_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("provider_tokens_user_id_provider_key").on(t.user_id, t.provider),
	],
);

export type CloudIdentity = typeof cloudIdentities.$inferSelect;
export type NewCloudIdentity = typeof cloudIdentities.$inferInsert;
export type ProviderToken = typeof providerTokens.$inferSelect;
export type NewProviderToken = typeof providerTokens.$inferInsert;
