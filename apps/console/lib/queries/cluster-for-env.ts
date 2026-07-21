// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { projectCluster, projectEnvironments } from "@/lib/db/schema";

type Executor = Db | Tx;

type ProjectClusterRow = typeof projectCluster.$inferSelect;

/**
 * Resolve the `project_cluster` row that SERVES a given environment, honoring the decoupled
 * env-model in which a cluster belongs to a **Fabric**, not an environment:
 *
 *  - a `dedicated` env resolves to its own 1:1 cluster (env↔Fabric 1:1 — the legacy shape);
 *  - `namespace`/`vcluster` envs placed on a SHARED Fabric resolve to that Fabric's single cluster
 *    (they have no cluster row of their own — the shared-cluster invariant enforced by the partial
 *    `project_cluster_fabric_id_key` unique index);
 *  - when no Fabric-linked cluster exists yet — a `dedicated`/legacy env whose cluster row still has
 *    a null `fabric_id` (createProject inserts it unset; `programmables.sql` backfills it later) — it
 *    falls back to the env-keyed row, so behaviour is byte-identical for any un-linked data.
 *
 * This is the canonical `env → Fabric → cluster` seam consumed by the placement-activation lanes
 * (deploy branch + keyless re-mint, ArgoCD destination, console cluster surfaces). Returns `null`
 * when the env's Fabric has no provisioned cluster yet. Accepts a `Db` or a transaction `Tx` so it
 * composes inside the deploy write-back / config-snapshot transactions.
 */
export async function resolveServingCluster(
	db: Executor,
	projectId: string,
	environmentId: string,
): Promise<ProjectClusterRow | null> {
	const [env] = await db
		.select({ fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, environmentId))
		.limit(1);

	// 1. Fabric-keyed (the authoritative shared-cluster model): a `namespace`/`vcluster` env — and a
	//    `dedicated` env whose cluster row has already been Fabric-linked — resolves here.
	if (env?.fabric_id) {
		const [byFabric] = await db
			.select()
			.from(projectCluster)
			.where(
				and(
					eq(projectCluster.project_id, projectId),
					eq(projectCluster.fabric_id, env.fabric_id),
				),
			)
			.limit(1);
		if (byFabric) return byFabric;
	}

	// 2. Env-key fallback: a `dedicated`/legacy env whose cluster row is NOT Fabric-linked yet — e.g.
	//    createProject inserts the cluster with a null fabric_id; the programmables.sql backfill links
	//    it later. Keeps resolution byte-identical for un-linked data (and for a `namespace` env whose
	//    Fabric has no cluster yet, returns null — nothing to serve it).
	const [byEnv] = await db
		.select()
		.from(projectCluster)
		.where(
			and(
				eq(projectCluster.project_id, projectId),
				eq(projectCluster.environment_id, environmentId),
			),
		)
		.limit(1);

	return byEnv ?? null;
}
