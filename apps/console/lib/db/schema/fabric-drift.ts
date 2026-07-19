// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 INFRA drift posture per Fabric (the decoupled env-model, #841). Infra drift is
// per-Fabric — the Fabric is the unit that owns the OpenTofu state (#838), so its
// `tofu plan -refresh-only -json` divergence belongs to the Fabric, not the delivery
// Environment (whose drift is ArgoCD OutOfSync). A DETECT_DRIFT job's refresh-only plan
// runs against the per-Fabric state object; the runner writes the same drift.Posture
// (packages/core/drift) here, keyed by the Fabric. One row per (project, fabric),
// upserted each run. Mirrors `environment_drift` and is likewise RLS-LESS (a project-child
// table) — the org boundary is enforced at query time by joining to the parent project and
// filtering on `projects.org_id`, not by a policy (see app/server/actions/drift.ts).

import { boolean, integer, jsonb, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { DriftDetail } from "@/types/jsonb.types";
import { projectFabrics } from "./project-fabrics";
import { projects } from "./projects";

export const fabricDrift = pgTable(
	"fabric_drift",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		fabric_id: uuid()
			.notNull()
			.references(() => projectFabrics.id, { onDelete: "cascade" }),
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
		unique("fabric_drift_project_id_fabric_id_key").on(t.project_id, t.fabric_id),
	],
);

export type FabricDrift = typeof fabricDrift.$inferSelect;
export type NewFabricDrift = typeof fabricDrift.$inferInsert;
