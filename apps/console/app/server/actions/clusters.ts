"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { currentActor } from "@/lib/authz/guard";
import { type ClusterData, readClusters } from "@/lib/rpc/procedures/clusters";

export type { ClusterData };

/**
 * Every cluster under management in the caller's org, for the server-side readers that are not the
 * Clusters page: the agent's `list_clusters` tool and the @-mention picker. The body is the read
 * procedure's (lib/rpc/procedures/clusters.ts `readClusters`, #6122), so they and the page agree on
 * what a cluster is. The page itself reads `clusters.list` over GET. No signed-in actor → no clusters.
 */
export async function getClusters(): Promise<ClusterData[]> {
	const actor = await currentActor().catch(() => null);
	if (!actor) return [];
	return readClusters(actor);
}
