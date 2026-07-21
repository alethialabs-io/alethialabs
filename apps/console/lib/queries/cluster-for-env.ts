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
 *  - legacy envs whose `fabric_id` the `programmables.sql` backfill hasn't set fall back to the
 *    env-keyed row, so behaviour is byte-identical for any un-migrated data.
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

	// A Fabric-linked env resolves by Fabric (shared cluster); otherwise fall back to the env key.
	const where = env?.fabric_id
		? and(
				eq(projectCluster.project_id, projectId),
				eq(projectCluster.fabric_id, env.fabric_id),
			)
		: and(
				eq(projectCluster.project_id, projectId),
				eq(projectCluster.environment_id, environmentId),
			);

	const [cluster] = await db
		.select()
		.from(projectCluster)
		.where(where)
		.limit(1);

	return cluster ?? null;
}
