// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 drift posture per project environment — the "keep proving it" half of elench.
// A DETECT_DRIFT job runs `tofu plan -refresh-only -json` and the runner writes the
// deterministic drift.Posture (packages/core/drift) here; the console + assistant + MCP
// read the latest posture. One row per (project, environment), upserted each run.

import { boolean, integer, jsonb, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { DriftDetail } from "@/types/jsonb.types";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

export const environmentDrift = pgTable(
	"environment_drift",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		environment_id: uuid().references(() => projectEnvironments.id, {
			onDelete: "cascade",
		}),
		// True when no managed resource has drifted from its provisioned state.
		in_sync: boolean().notNull(),
		// Count of diverged (modified/deleted-out-of-band) resources.
		drifted: integer().default(0).notNull(),
		// Per-resource drift list (mirrors drift.Posture.Details).
		details: jsonb().$type<DriftDetail[]>().default([]),
		// When the refresh-only plan was taken (RFC3339, runner-supplied).
		scanned_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("environment_drift_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);
