// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 security posture per project environment (L9). A DEPLOY (and, later, a scheduled
// inspect) reads the Trivy-Operator VulnerabilityReports from the cluster and writes the
// aggregated severity counts here; the Evidence Security tab reads the latest. One row per
// (project, environment), upserted each scan. `scanned=false` means Trivy isn't installed.

import { boolean, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { projectEnvironments } from "./project-environments";
import { projects } from "./projects";

export const environmentSecurity = pgTable(
	"environment_security",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		environment_id: uuid().references(() => projectEnvironments.id, {
			onDelete: "cascade",
		}),
		// Aggregated vulnerability counts across the cluster's Trivy reports.
		critical: integer().default(0).notNull(),
		high: integer().default(0).notNull(),
		medium: integer().default(0).notNull(),
		low: integer().default(0).notNull(),
		// Number of VulnerabilityReports that fed the aggregate.
		report_count: integer().default(0).notNull(),
		// False when Trivy-Operator isn't installed / has produced no reports yet — the UI
		// then shows "not scanned" rather than a misleading all-clear.
		scanned: boolean().default(false).notNull(),
		scanned_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("environment_security_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);
