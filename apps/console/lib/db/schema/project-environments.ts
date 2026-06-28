// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project environments (M1). A project is an *app* that owns N environments, each an
// independently-provisionable deployment target. The environment's `name` feeds the
// OpenTofu/S3 state key (projectName-<name>-region/tofu.tfstate) — backfilled
// from the project's old `environment_stage` so the state path is byte-identical — and
// `status` carries the per-environment provisioning lifecycle (moved off projects.status).
// Exactly one row per project is the `is_default` representative used by single-value
// surfaces (the CLI wire, the project "Env"/status columns, the project-detail header).

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
import { environmentStage, projectStatus } from "./enums";
import { projects } from "./projects";

export const projectEnvironments = pgTable(
	"project_environments",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Slug feeding the tofu state path + the URL (C2). Backfilled = the old stage value.
		name: text().notNull(),
		// Drives provider template defaults (dev/staging/prod knobs); distinct from `name`.
		stage: environmentStage().default("development").notNull(),
		// Per-environment provisioning lifecycle (was projects.status).
		status: projectStatus().default("DRAFT").notNull(),
		// Exactly one default per project — the representative env for single-value surfaces.
		is_default: boolean().default(false).notNull(),
		// NULL inherits projects.region.
		region: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("project_environments_project_id_name_key").on(t.project_id, t.name),
		// At most one default environment per project (partial unique).
		uniqueIndex("project_environments_one_default")
			.on(t.project_id)
			.where(sql`${t.is_default} = true`),
		index("idx_project_environments_project").on(t.project_id),
	],
);

export type ProjectEnvironment = typeof projectEnvironments.$inferSelect;
export type NewProjectEnvironment = typeof projectEnvironments.$inferInsert;
