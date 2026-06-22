// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Spec environments (M1). A spec is an *app* that owns N environments, each an
// independently-provisionable deployment target. The environment's `name` feeds the
// OpenTofu/S3 state key (zoneID/projectName-<name>-region/tofu.tfstate) — backfilled
// from the spec's old `environment_stage` so the state path is byte-identical — and
// `status` carries the per-environment provisioning lifecycle (moved off specs.status).
// Exactly one row per spec is the `is_default` representative used by single-value
// surfaces (the CLI wire, the zone "Env"/status columns, the spec-detail header).

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { environmentStage, specStatus } from "./enums";
import { specs } from "./specs";

export const specEnvironments = pgTable(
	"spec_environments",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: uuid()
			.notNull()
			.references(() => specs.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Slug feeding the tofu state path + the URL (C2). Backfilled = the old stage value.
		name: text().notNull(),
		// Drives provider template defaults (dev/staging/prod knobs); distinct from `name`.
		stage: environmentStage().default("development").notNull(),
		// Per-environment provisioning lifecycle (was specs.status).
		status: specStatus().default("DRAFT").notNull(),
		// Exactly one default per spec — the representative env for single-value surfaces.
		is_default: boolean().default(false).notNull(),
		// NULL inherits specs.region.
		region: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("spec_environments_spec_id_name_key").on(t.spec_id, t.name),
		// At most one default environment per spec (partial unique).
		uniqueIndex("spec_environments_one_default")
			.on(t.spec_id)
			.where(sql`${t.is_default} = true`),
		index("idx_spec_environments_spec").on(t.spec_id),
	],
);

export type SpecEnvironment = typeof specEnvironments.$inferSelect;
export type NewSpecEnvironment = typeof specEnvironments.$inferInsert;
