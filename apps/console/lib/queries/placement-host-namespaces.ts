// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { projectAddons, projectEnvironments } from "@/lib/db/schema";

type Executor = Db | Tx;

/**
 * The namespaces the HOST of a Fabric uses for its own bring-your-own charts (#6551): every namespace
 * a BYO chart of a `dedicated` environment on `fabricId` chose. A namespace placement on that Fabric
 * may not use one (lib/validations/placement-namespace.ts, and the runner from the snapshot's
 * `placement_host_namespaces`). A chart with no namespace of its own deploys into `byo-<chart id>`,
 * which the static `byo-` placement prefix already covers, so only chosen names are listed.
 *
 * Disabled charts are included: their Application can still be on the cluster, and reserving a name
 * for too long costs a rename, while releasing it too early hands a tenant the chart's namespace.
 * Sorted and distinct, so the snapshot bytes do not depend on row order.
 */
export async function placementHostNamespaces(
	db: Executor,
	projectId: string,
	fabricId: string,
): Promise<string[]> {
	const hosts = db
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.fabric_id, fabricId),
				eq(projectEnvironments.placement_mode, "dedicated"),
			),
		);
	const rows = await db
		.select({ namespace: projectAddons.namespace })
		.from(projectAddons)
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.source, "byo"),
				isNotNull(projectAddons.namespace),
				inArray(projectAddons.environment_id, hosts),
			),
		);
	const names = new Set<string>();
	for (const r of rows) {
		const ns = r.namespace?.trim();
		if (ns) names.add(ns);
	}
	return [...names].sort();
}
