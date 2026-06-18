// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

// Zone — a workspace/environment a user owns. Column keys are snake_case to
// match the wire/Postgres and the existing app shape. `user_id` carries the auth
// subject (no cross-DB FK to auth.users — Better Auth owns users in Phase D).
export const zones = pgTable(
	"zones",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope for the RLS blast wall. Community: org_id = user_id
		// (a trigger backfills it). The ee/ Teams build sets a real organization id.
		org_id: uuid(),
		name: text().notNull(),
		description: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("zones_user_id_name_key").on(t.user_id, t.name),
		index("idx_zones_user").on(t.user_id),
		index("idx_zones_org").on(t.org_id),
	],
);

export type Zone = typeof zones.$inferSelect;
export type NewZone = typeof zones.$inferInsert;
