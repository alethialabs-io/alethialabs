// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Durable connector-credential health (spec/mvp/25-alerting-notifications.md Phase 3).
// Updated at POINT OF USE (git token refresh in getValidProviderToken, api-key decrypt
// in the job-claim path) — NOT a poll. `alerted_at` powers a once-per-transition emit of
// `system.connector.token_failed` (lib/connectors/health.ts). One row per
// (user, kind, provider); git stays per-user (Better-Auth `account` is not ours to extend).

import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { connectorHealthKind, connectorHealthStatus } from "./enums";

export const connectorHealth = pgTable(
	"connector_health",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Coarse tenancy scope; community org_id = user_id.
		org_id: uuid().notNull(),
		user_id: uuid().notNull(),
		kind: connectorHealthKind().notNull(),
		// Git provider ("github"/…) or connector slug ("cloudflare"/…).
		provider: text().notNull(),
		status: connectorHealthStatus().notNull(),
		last_error: text(),
		last_checked_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// When we last fired an alert for the current failure (re-alert window guard).
		alerted_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("connector_health_user_kind_provider").on(
			t.user_id,
			t.kind,
			t.provider,
		),
		index("idx_connector_health_org").on(t.org_id),
	],
);

export type ConnectorHealth = typeof connectorHealth.$inferSelect;
export type NewConnectorHealth = typeof connectorHealth.$inferInsert;
