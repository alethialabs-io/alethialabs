// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { displayedK8sVersion } from "@/lib/cloud-providers/hetzner-k8s-pin";
import { type KubeconfigAccess, readKubeconfigAccess } from "@/lib/clusters/kubeconfig-access";
import { withActorScope } from "@/lib/db";
import {
	cloudIdentities,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectRepositories,
	projects,
} from "@/lib/db/schema";
import { type AssignedValue, assignmentsForKind } from "@/lib/queries/classification";
import { managedClusterEnvJoin, managedClusterPredicate } from "@/lib/queries/usage-counts";
import { query } from "@/lib/rpc/base";

/**
 * One cluster under management (lib/queries/usage-counts.ts `managedClusterPredicate`), with its
 * project and the data services of the environment that owns it. One per CLUSTER: a project with a
 * dedicated cluster per environment has one of these per environment.
 */
export interface ClusterData {
	/** The PROJECT's id (the project drilldown filters on it). The cluster's own id is `project_cluster.id`. */
	id: string;
	project_name: string;
	region: string;
	/** The name of the environment that owns this cluster. */
	environment_stage: string;
	/** That environment's provisioning lifecycle (`project_environments.status`). */
	status: string;
	cloud_identities: { provider: string } | null;
	project_cluster: {
		/** project_cluster row id — the classifiable `project_cluster` resource. */
		id: string;
		cluster_name: string | null;
		cluster_endpoint: string | null;
		cluster_arn: string | null;
		cluster_version: string | null;
		/** The Kubernetes version the cluster installs, for display. On Hetzner this is the Talos
		 *  pin whatever `cluster_version` holds, because Hetzner never reads that field (#5366);
		 *  elsewhere it is `cluster_version`. Null when unset. */
		k8s_version: string | null;
		argocd_url: string | null;
		status: string;
		/** How to get a kubeconfig — `alethia cluster kubeconfig`, and the cloud-CLI alternative where
		 *  there is one — the same object `alethia cluster get` prints (lib/clusters/kubeconfig-access.ts). */
		kubeconfig: KubeconfigAccess;
	};
	project_databases: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		reader_endpoint: string | null;
		master_credentials_secret_arn: string | null;
		status: string;
	}[];
	project_caches: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		status: string;
	}[];
	project_dns: { domain_name: string | null; enabled: boolean } | null;
	/** The GitOps apps destination repo (#574); null = direct apply (no apps repo wired). */
	apps_destination_repo: string | null;
}

/** What the Clusters page renders per card: the cluster, plus what the card needs to paint at once. */
export interface ClusterListItem extends ClusterData {
	/** Whether the viewer may download a read-only kubeconfig (`cluster:access_readonly`). A DISPLAY
	 *  decision — the download request re-checks (app/server/actions/kubeconfig-download.ts). */
	can_download_kubeconfig: boolean;
	/** The classification chips on this cluster (empty without `org:view`). */
	classification: AssignedValue[];
}

/**
 * Every cluster under management in the actor's org, newest project first and, within a project,
 * its default environment's cluster first.
 *
 * Authorization: `project:view` (as the project list), then the read runs on the RLS-enforced app
 * role with the actor's own scope (`withActorScope`): clusters are org-shared, so the scope must
 * carry the real org — an owner scope would hide every cluster another member created.
 *
 * The kubeconfig command per cluster comes from the same builder the CLI route serves; its reads run
 * concurrently inside this transaction rather than one after another per cluster.
 */
export async function readClusters(actor: Actor): Promise<ClusterData[]> {
	await getPdp().enforce(actor, "view", { type: "project" });

	return withActorScope(actor, async (tx) => {
		// The cluster's own placement wins over its project's (per-resource cloud placement, #5250 §5).
		const identityId = sql`coalesce(${projectCluster.cloud_identity_id}, ${projects.cloud_identity_id})`;
		const baseRows = await tx
			.select({
				id: projects.id,
				project_name: projects.project_name,
				region: sql<string>`coalesce(${projectCluster.region}, ${projects.region})`,
				environment_stage: projectEnvironments.name,
				environment_status: projectEnvironments.status,
				provider: cloudIdentities.provider,
				cluster_id: projectCluster.id,
				cluster_environment_id: projectCluster.environment_id,
				cluster_name: projectCluster.cluster_name,
				cluster_endpoint: projectCluster.cluster_endpoint,
				cluster_outputs: projectCluster.provider_outputs,
				cluster_version: projectCluster.cluster_version,
				argocd_url: projectCluster.argocd_url,
				cluster_status: projectCluster.status,
				dns_domain_name: projectDns.domain_name,
				dns_enabled: projectDns.enabled,
				apps_destination_repo: projectRepositories.apps_destination_repo,
			})
			.from(projectCluster)
			.innerJoin(projects, eq(projectCluster.project_id, projects.id))
			.innerJoin(projectEnvironments, managedClusterEnvJoin())
			.leftJoin(cloudIdentities, eq(cloudIdentities.id, identityId))
			.leftJoin(
				projectDns,
				and(
					eq(projectDns.project_id, projectCluster.project_id),
					eq(projectDns.environment_id, projectCluster.environment_id),
				),
			)
			.leftJoin(
				projectRepositories,
				and(
					eq(projectRepositories.project_id, projectCluster.project_id),
					eq(projectRepositories.environment_id, projectCluster.environment_id),
				),
			)
			.where(managedClusterPredicate())
			.orderBy(
				desc(projects.created_at),
				desc(projectEnvironments.is_default),
				projectEnvironments.name,
				projectCluster.id,
			);

		if (baseRows.length === 0) return [];

		// Components are environment-scoped: each cluster's data services are its own environment's.
		const envIds = [
			...new Set(baseRows.map((r) => r.cluster_environment_id).filter((x): x is string => Boolean(x))),
		];

		const [dbRows, cacheRows, kubeconfigs] = await Promise.all([
			tx
				.select({
					environment_id: projectDatabases.environment_id,
					name: projectDatabases.name,
					engine: projectDatabases.engine,
					endpoint: projectDatabases.endpoint,
					reader_endpoint: projectDatabases.reader_endpoint,
					provider_outputs: projectDatabases.provider_outputs,
					status: projectDatabases.status,
				})
				.from(projectDatabases)
				.where(inArray(projectDatabases.environment_id, envIds)),
			tx
				.select({
					environment_id: projectCaches.environment_id,
					name: projectCaches.name,
					engine: projectCaches.engine,
					endpoint: projectCaches.endpoint,
					status: projectCaches.status,
				})
				.from(projectCaches)
				.where(inArray(projectCaches.environment_id, envIds)),
			Promise.all(
				baseRows.map((r) =>
					readKubeconfigAccess(tx, {
						clusterId: r.cluster_id,
						projectId: r.id,
						environmentId: r.cluster_environment_id,
						clusterName: r.cluster_name,
						provider: r.provider,
						region: r.region,
					}),
				),
			),
		]);

		return baseRows.map((r, i) => ({
			id: r.id,
			project_name: r.project_name,
			region: r.region,
			environment_stage: r.environment_stage,
			status: r.environment_status,
			cloud_identities: r.provider ? { provider: r.provider } : null,
			project_cluster: {
				id: r.cluster_id,
				cluster_name: r.cluster_name,
				cluster_endpoint: r.cluster_endpoint,
				cluster_arn: r.cluster_outputs?.arn ?? null,
				cluster_version: r.cluster_version,
				k8s_version: displayedK8sVersion(r.provider, r.cluster_version),
				argocd_url: r.argocd_url,
				status: r.cluster_status,
				kubeconfig: kubeconfigs[i],
			},
			project_databases: dbRows
				.filter((d) => d.environment_id === r.cluster_environment_id)
				.map(({ environment_id: _e, provider_outputs, ...db }) => ({
					...db,
					master_credentials_secret_arn: provider_outputs?.secret_ref ?? null,
				})),
			project_caches: cacheRows
				.filter((c) => c.environment_id === r.cluster_environment_id)
				.map(({ environment_id: _e, ...c }) => c),
			project_dns:
				r.dns_enabled !== null ? { domain_name: r.dns_domain_name, enabled: r.dns_enabled } : null,
			apps_destination_repo: r.apps_destination_repo ?? null,
		}));
	});
}

/**
 * Whether `actor` may download a read-only kubeconfig for each cluster — `cluster:access_readonly`,
 * the action the download request itself enforces. Non-recording (`can`, not `enforce`) and
 * fail-closed per cluster: any error is false. Asked only of clusters with an endpoint, the only
 * ones whose card offers the download.
 */
async function downloadableClusters(actor: Actor, clusters: ClusterData[]): Promise<Set<string>> {
	const pdp = getPdp();
	const ids = clusters.filter((c) => c.project_cluster.cluster_endpoint).map((c) => c.project_cluster.id);
	const allowed = await Promise.all(
		ids.map((id) =>
			pdp.can(actor, "access_readonly", { type: "cluster", id }).then(
				(decision) => decision.allowed,
				() => false,
			),
		),
	);
	return new Set(ids.filter((_id, i) => allowed[i]));
}

/**
 * The classification chips of every cluster, in one batched read. Chips need `org:view` — the check
 * the chips' own read makes (app/server/actions/classification/assignments.ts); without it the
 * clusters still render, chipless.
 */
async function clusterChips(actor: Actor, clusters: ClusterData[]): Promise<Map<string, AssignedValue[]>> {
	if (clusters.length === 0) return new Map();
	const decision = await getPdp().can(actor, "view", { type: "org" });
	if (!decision.allowed) return new Map();
	return withActorScope(actor, (tx) =>
		assignmentsForKind(
			tx,
			"project_cluster",
			clusters.map((c) => c.project_cluster.id),
		),
	);
}

/**
 * The Clusters page's read: every cluster under management, plus — so a card paints complete with no
 * request of its own (RUBRIC B1) — whether the viewer may download its kubeconfig and its
 * classification chips.
 */
export async function readClusterList(actor: Actor): Promise<ClusterListItem[]> {
	const clusters = await readClusters(actor);
	const [downloadable, chips] = await Promise.all([
		downloadableClusters(actor, clusters),
		clusterChips(actor, clusters),
	]);
	return clusters.map((c) => ({
		...c,
		can_download_kubeconfig: downloadable.has(c.project_cluster.id),
		classification: chips.get(c.project_cluster.id) ?? [],
	}));
}

/**
 * The clusters domain's reads (ADR 0005 D1, #6122). `list` serves `/~/clusters` and the project
 * drilldown's Clusters page (one org-wide key; the drilldown filters it to its project), resolved for
 * the actor the entry point bound from the request's ADDRESS — never the session's org.
 */
export const clustersRouter = {
	list: query.handler(({ context }) => readClusterList(context.actor)),
};
