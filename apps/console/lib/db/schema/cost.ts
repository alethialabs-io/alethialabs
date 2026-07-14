// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Persisted infrastructure cost, per environment (W5).
//
// The pipeline already existed end to end and simply stopped short of the database: the runner runs
// Infracost on every PLAN (packages/core/infracost) and writes the breakdown into
// `jobs.execution_metadata.cost_breakdown`, which `lib/plan/parse-cost.ts` already parses. It was
// never STORED — so:
//
//   • `estimated_monthly_cost` exists on `projects` and on every `project_*` table, is READ by
//     lib/queries/usage-counts.ts, and was written by nothing;
//   • the cost promotion gate is fully implemented and permanently inert — promotions.ts hardcodes
//     `costDelta: null` with the comment "Cost baseline isn't persisted per-env yet";
//   • and there was no way to answer "what does this environment cost?".
//
// One row per (environment, plan job): what that plan said the environment would cost.

import {
	index,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { CostResourceLine } from "@/types/jsonb.types";
import { jobs } from "./jobs";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

export const environmentCost = pgTable(
	"environment_cost",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		environment_id: uuid()
			.notNull()
			.references(() => projectEnvironments.id, { onDelete: "cascade" }),
		// The PLAN this cost came from. On delete set null so pruning job history doesn't erase the
		// cost record — the number stays true even once the job row is gone.
		plan_job_id: uuid().references(() => jobs.id, { onDelete: "set null" }),
		// The authoritative figure: what Infracost priced this plan at.
		total_monthly: numeric({ precision: 12, scale: 2, mode: "number" }),
		currency: text().default("USD").notNull(),
		// Per-resource lines, so a card can show its OWN cost and not just the environment's total.
		resources: jsonb().$type<CostResourceLine[]>().default([]),
		captured_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// The reads are always "the latest cost for this environment".
		index("idx_environment_cost_env_time").on(t.environment_id, t.captured_at),
	],
);
