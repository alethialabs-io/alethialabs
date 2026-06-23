// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { cloudIdentities } from "./identities";
import { zones } from "./zones";

// Spec — a declarative infrastructure config a user writes, inside a Zone. M1: a
// spec is an *app* that owns N environments (spec_environments) — the environment
// identity (name/stage) and the per-environment provisioning `status` moved off this
// table into spec_environments. region / iac_version carry NO default: multi-cloud
// means the provider dictates valid regions, and the IaC version is chosen explicitly.
export const specs = pgTable(
	"specs",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		zone_id: uuid().references(() => zones.id, { onDelete: "set null" }),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		project_name: text().notNull(),
		// URL slug (C2), unique per zone. Nullable for the additive add + backfill
		// (migration 0023); the app always sets it on create.
		slug: text(),
		region: text().notNull(),
		iac_version: text().notNull(),
		estimated_monthly_cost: numeric({ precision: 12, scale: 2, mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("specs_zone_id_slug_key").on(t.zone_id, t.slug),
		index("idx_specs_user").on(t.user_id),
		index("idx_specs_org").on(t.org_id),
		index("idx_specs_zone").on(t.zone_id),
		index("idx_specs_cloud_identity").on(t.cloud_identity_id),
	],
);

export type Spec = typeof specs.$inferSelect;
export type NewSpec = typeof specs.$inferInsert;
