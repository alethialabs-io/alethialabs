// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project fabrics — the INFRASTRUCTURE unit in the decoupled env-model
// (spec management/spec/features/environments-fabric-placement.md). A project owns N Fabrics.
// A Fabric is a control plane + network + cluster-scoped shared add-ons (ingress, cert-manager,
// monitoring, in-cluster S3, ArgoCD) + its OWN tofu state; it may be Alethia-templated or BYO-IaC
// (the customer's OpenTofu attaches at the Fabric — ceiling per-Fabric). Delivery Environments are
// PLACED onto a Fabric (placement_mode ∈ namespace|vcluster|dedicated); a `dedicated` env owns a
// Fabric 1:1 (≈ the legacy env=cluster behaviour). Infra drift is per-Fabric (tofu refresh-only);
// delivery drift is per-Environment (ArgoCD). This is the interface-first seam (#836): downstream
// lanes re-parent tofu-state + the cluster/network components onto the Fabric (#838) and move the
// BYO-IaC attach point here (#839).

import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { projectStatus } from "./enums";
import { cloudIdentities } from "./identities";
import { projects } from "./projects";

export const projectFabrics = pgTable(
	"project_fabrics",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Fabric slug — feeds the per-Fabric tofu state key (#838 re-keys state onto this).
		name: text().notNull(),
		// Which connector/cloud this Fabric provisions in. NULL inherits projects.cloud_identity_id.
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		// NULL inherits projects.region.
		region: text(),
		// Per-Fabric infra provisioning lifecycle (mirrors project_environments.status semantics).
		status: projectStatus().default("DRAFT").notNull(),
		status_message: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("project_fabrics_project_id_name_key").on(t.project_id, t.name),
		index("idx_project_fabrics_project").on(t.project_id),
	],
);

export type ProjectFabric = typeof projectFabrics.$inferSelect;
export type NewProjectFabric = typeof projectFabrics.$inferInsert;
