// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { type AnyColumn, and, eq } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import {
	clusterAdminsByCluster,
	serviceBindingsByOwner,
	topicSubscriptionsByTopic,
} from "@/lib/db/normalized-reads";
import {
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectSourceRepos,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";
import type {
	ClusterAdmin,
	ServiceBinding,
	TopicSubscription,
} from "@/types/jsonb.types";

type Executor = Db | Tx;

/**
 * The `project_id AND environment_id` predicate — the single definition shared by every env-scoped
 * component read/write. Components are environment-scoped, so this pair is their tenancy key.
 */
export function envScope(
	table: { project_id: AnyColumn; environment_id: AnyColumn },
	projectId: string,
	environmentId: string,
) {
	return and(
		eq(table.project_id, projectId),
		eq(table.environment_id, environmentId),
	);
}

/**
 * Raw component rows for one (project, environment), plus the three normalized-child derivations
 * (`topicSubs` map, `clusterAdmins` list, `serviceBindings` map). Callers apply their own transforms
 * on top: the frontend
 * (`getProject`) enriches topics/cluster into `ProjectFormData` shape; `buildConfigSnapshot` layers
 * placement resolution + gates onto these same rows. Returning raw pieces (not a pre-shaped object)
 * keeps each caller's transform — and the frozen config_snapshot bytes — unchanged.
 */
export interface EnvComponentRows {
	// Singletons are returned RAW (undefined when the env has no row) — not coerced to null — so
	// buildConfigSnapshot sees the exact `const [x] = …` semantics it had before; getProject applies
	// its own `?? null` in the form-shape transform.
	network: typeof projectNetwork.$inferSelect | undefined;
	/** The env-keyed cluster row (opts.cluster === "env"); undefined when omitted or absent. */
	cluster: typeof projectCluster.$inferSelect | undefined;
	/** Admins for `cluster` (empty when cluster is absent / omitted). */
	clusterAdmins: ClusterAdmin[];
	dns: typeof projectDns.$inferSelect | undefined;
	repositories: typeof projectRepositories.$inferSelect | undefined;
	sourceRepos: (typeof projectSourceRepos.$inferSelect)[];
	databases: (typeof projectDatabases.$inferSelect)[];
	caches: (typeof projectCaches.$inferSelect)[];
	queues: (typeof projectQueues.$inferSelect)[];
	topics: (typeof projectTopics.$inferSelect)[];
	/** Subscriptions keyed by topic id (topic_subscriptions child table). */
	topicSubs: Map<string, TopicSubscription[]>;
	nosqlTables: (typeof projectNosqlTables.$inferSelect)[];
	secrets: (typeof projectSecrets.$inferSelect)[];
	storageBuckets: (typeof projectStorageBuckets.$inferSelect)[];
	containerRegistries: (typeof projectContainerRegistries.$inferSelect)[];
	helmRegistries: (typeof projectHelmRegistries.$inferSelect)[];
	services: (typeof projectServices.$inferSelect)[];
	/**
	 * W3 bindings keyed by SERVICE id (service_bindings child table). Services with no bindings are
	 * absent from the map — callers default to `[]`, matching the dropped JSONB column's `.default([])`.
	 * Chart-workload bindings share the same child table but are read separately by the snapshot
	 * (`project_chart_workloads` is snapshot-only, so it is not one of this layer's tables).
	 */
	serviceBindings: Map<string, ServiceBinding[]>;
}

/**
 * Reads the common env-scoped component tables for one (project, environment) under the caller's
 * `tx`/scope (RLS actor scope for the frontend, `withScope` for the snapshot). The cluster read is
 * gated: `"env"` (default) returns the env-keyed `project_cluster` row (what the design form shows);
 * `"none"` omits it so `buildConfigSnapshot` can resolve the Fabric-based SERVING cluster itself
 * (`resolveServingCluster`) without a redundant/ conflicting read. Snapshot-only tables
 * (observability, addons, chart_workloads, iac_sources, classification) stay in `buildConfigSnapshot`.
 */
export async function readEnvComponents(
	tx: Executor,
	projectId: string,
	envId: string,
	opts?: { cluster?: "env" | "none" },
): Promise<EnvComponentRows> {
	const [network] = await tx
		.select()
		.from(projectNetwork)
		.where(envScope(projectNetwork, projectId, envId))
		.limit(1);
	let cluster: typeof projectCluster.$inferSelect | undefined;
	if ((opts?.cluster ?? "env") === "env") {
		[cluster] = await tx
			.select()
			.from(projectCluster)
			.where(envScope(projectCluster, projectId, envId))
			.limit(1);
	}
	const [dns] = await tx
		.select()
		.from(projectDns)
		.where(envScope(projectDns, projectId, envId))
		.limit(1);
	const [repos] = await tx
		.select()
		.from(projectRepositories)
		.where(envScope(projectRepositories, projectId, envId))
		.limit(1);
	const sourceRepos = await tx
		.select()
		.from(projectSourceRepos)
		.where(envScope(projectSourceRepos, projectId, envId));
	const databases = await tx
		.select()
		.from(projectDatabases)
		.where(envScope(projectDatabases, projectId, envId));
	const caches = await tx
		.select()
		.from(projectCaches)
		.where(envScope(projectCaches, projectId, envId));
	const queues = await tx
		.select()
		.from(projectQueues)
		.where(envScope(projectQueues, projectId, envId));
	const topics = await tx
		.select()
		.from(projectTopics)
		.where(envScope(projectTopics, projectId, envId));
	const nosqlTables = await tx
		.select()
		.from(projectNosqlTables)
		.where(envScope(projectNosqlTables, projectId, envId));
	const secrets = await tx
		.select()
		.from(projectSecrets)
		.where(envScope(projectSecrets, projectId, envId));
	const storageBuckets = await tx
		.select()
		.from(projectStorageBuckets)
		.where(envScope(projectStorageBuckets, projectId, envId));
	const containerRegistries = await tx
		.select()
		.from(projectContainerRegistries)
		.where(envScope(projectContainerRegistries, projectId, envId));
	const helmRegistries = await tx
		.select()
		.from(projectHelmRegistries)
		.where(envScope(projectHelmRegistries, projectId, envId));
	const services = await tx
		.select()
		.from(projectServices)
		.where(envScope(projectServices, projectId, envId));
	const topicSubs = await topicSubscriptionsByTopic(
		tx,
		topics.map((t) => t.id),
	);
	const clusterAdmins = cluster
		? await clusterAdminsByCluster(tx, cluster.id)
		: [];
	const serviceBindings = await serviceBindingsByOwner(tx, {
		serviceIds: services.map((s) => s.id),
		chartWorkloadIds: [],
	});
	return {
		network,
		cluster,
		clusterAdmins,
		dns,
		repositories: repos,
		sourceRepos,
		databases,
		caches,
		queues,
		topics,
		topicSubs,
		nosqlTables,
		secrets,
		storageBuckets,
		containerRegistries,
		helmRegistries,
		services,
		serviceBindings,
	};
}
