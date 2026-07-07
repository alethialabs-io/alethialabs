// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

// Project — a declarative infrastructure config a user writes; the top-level **Project** under
// an org. M1: a project is an *app* that owns N
// environments (project_environments) — the environment identity (name/stage) and the
// per-environment provisioning `status` live in project_environments. region / iac_version carry
// NO default: multi-cloud means the provider dictates valid regions, and the IaC version is
// chosen explicitly.
export const projects = pgTable(
	"projects",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		project_name: text().notNull(),
		// URL slug (C2), unique per org. Nullable for the additive add + backfill
		// (migration 0023); the app always sets it on create.
		slug: text(),
		region: text().notNull(),
		iac_version: text().notNull(),
		estimated_monthly_cost: numeric({ precision: 12, scale: 2, mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("projects_org_id_slug_key").on(t.org_id, t.slug),
		index("idx_projects_user").on(t.user_id),
		index("idx_projects_org").on(t.org_id),
		index("idx_projects_cloud_identity").on(t.cloud_identity_id),
	],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
