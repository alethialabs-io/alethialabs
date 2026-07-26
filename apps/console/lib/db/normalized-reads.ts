// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read the normalized value-object child tables back into their in-memory array shapes (the JSONB
// audit's CONTRACT PHASE — the JSONB columns on the parent rows are dropped, so these readers are the
// single source for the arrays that used to live on those columns). Each loader is a batch query
// (no N+1), orders by `ordinal` so the reconstructed array matches author order, and returns `[]` for
// an owner with no rows. Callers pass their own `Db`/`Tx` handle so the read runs under the same
// RLS/owner scope as the surrounding query.
//
// Byte-stability note: the config-snapshot signature (canonicalJson, sorted keys), the CLI
// `configuration_hash` (over the Postgres-jsonb-normalized read-back) and `structuralHash`
// (stableStringify, sorted keys) are all key-order-independent, so only element *values* and array
// *order* must match the old JSONB — both of which `ordinal` guarantees.

import { eq, inArray } from "drizzle-orm";
import { clusterAdmins, topicSubscriptions } from "@/lib/db/schema";
import type { Db, Tx } from "@/lib/db";
import type { ClusterAdmin, TopicSubscription } from "@/types/jsonb.types";

/**
 * Load the subscriptions for a set of topics, keyed by topic id, ordered by `ordinal`. Topics with no
 * subscription rows are simply absent from the map (callers default to `[]`).
 */
export async function topicSubscriptionsByTopic(
	db: Db | Tx,
	topicIds: string[],
): Promise<Map<string, TopicSubscription[]>> {
	const map = new Map<string, TopicSubscription[]>();
	if (!topicIds.length) return map;
	const rows = await db
		.select({
			topic_id: topicSubscriptions.topic_id,
			protocol: topicSubscriptions.protocol,
			endpoint: topicSubscriptions.endpoint,
		})
		.from(topicSubscriptions)
		.where(inArray(topicSubscriptions.topic_id, topicIds))
		.orderBy(topicSubscriptions.topic_id, topicSubscriptions.ordinal);
	for (const r of rows) {
		const arr = map.get(r.topic_id);
		const sub: TopicSubscription = { protocol: r.protocol, endpoint: r.endpoint };
		if (arr) arr.push(sub);
		else map.set(r.topic_id, [sub]);
	}
	return map;
}

/**
 * Load a single cluster's day-2 admins, ordered by `ordinal`. Returns `[]` when the cluster has none.
 * (project_cluster is a per-env singleton, so this reads one cluster's rows.)
 */
export async function clusterAdminsByCluster(
	db: Db | Tx,
	clusterId: string,
): Promise<ClusterAdmin[]> {
	const rows = await db
		.select({ username: clusterAdmins.username, groups: clusterAdmins.groups })
		.from(clusterAdmins)
		.where(eq(clusterAdmins.cluster_id, clusterId))
		.orderBy(clusterAdmins.ordinal);
	return rows.map((r) => ({ username: r.username, groups: r.groups }));
}
