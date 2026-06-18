// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AzureCachedResources,
	CachedResources,
	CloudCredentials,
	GcpCachedResources,
} from "@/types/database-custom.types";
import { cloudProvider } from "./enums";

// Cloud credential anchors. `credentials`/`cached_resources` are typed JSONB.
export const cloudIdentities = pgTable(
	"cloud_identities",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
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
	(t) => [
		index("idx_cloud_identities_user").on(t.user_id),
		index("idx_cloud_identities_org").on(t.org_id),
	],
);

// Git OAuth tokens were retired into Better Auth's `account` table in Phase D
// (the provider_tokens table is dropped). The gitProvider enum lives on in
// enums.ts — its GitProvider type still names the git providers app-wide.

export type CloudIdentity = typeof cloudIdentities.$inferSelect;
export type NewCloudIdentity = typeof cloudIdentities.$inferInsert;
