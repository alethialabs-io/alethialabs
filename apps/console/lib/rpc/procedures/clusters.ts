// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getPdp } from "@/lib/authz";
import type { Actor, BulkCheck, Decision } from "@/lib/authz/types";
import { cliViewableProjectIds } from "@/lib/cli/project-access";
import { displayedK8sVersion } from "@/lib/cloud-providers/hetzner-k8s-pin";
import {
	KUBECONFIG_MINT_UNPROVISIONED_REASON,
	MINT_UNPROVISIONED_ENV_STATUSES,
} from "@/lib/clusters/mint-eligibility";
import { type KubeconfigAccess, readKubeconfigAccess } from "@/lib/clusters/kubeconfig-access";
import { readClusterEvidence } from "@/lib/clusters/observed-evidence";
import {
	type ControlPlaneObservation,
	KUBECONFIG_MISSING_CLUSTER_NOTE,
	observeControlPlane,
} from "@/lib/clusters/observed-state";
import { withActorScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectRepositories,
	projects,
} from "@/lib/db/schema";
import { type AssignedValue, assignmentsForKind } from "@/lib/queries/classification";
import { type ClustersPage, queryClustersPage } from "@/lib/queries/clusters";
import { KEYSET_DEFAULT_LIMIT, keysetPageInput } from "@/lib/queries/keyset";
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
	/** The project's URL slug, for links into it; null on a project written before slugs. */
	project_slug: string | null;
	region: string;
	/** The id of the environment that owns this cluster — what a missing cluster's actions act on. */
	environment_id: string | null;
	/** The name of the environment that owns this cluster. */
	environment_stage: string;
	/** That environment's provisioning lifecycle (`project_environments.status`). */
	status: string;
	/** When that status was last written (`project_environments.updated_at`) — how long a run has
	 *  been "in flight", so a status nothing has moved for months is not shown as current. */
	status_since: string;
	cloud_identities: { provider: string } | null;
	project_cluster: {
		/** project_cluster row id — the classifiable `project_cluster` resource. */
		id: string;
		/** When the cluster row was created (ISO) — the clusters list's sort key. */
		created_at: string;
		cluster_name: string | null;
		cluster_endpoint: string | null;
		cluster_arn: string | null;
		cluster_version: string | null;
		/** The Kubernetes version the cluster installs, for display. On Hetzner this is the Talos
		 *  pin whatever `cluster_version` holds, because Hetzner never reads that field (#5366);
		 *  elsewhere it is `cluster_version`. Null when unset. */
		k8s_version: string | null;
		argocd_url: string | null;
		/** What the last successful deploy recorded (`project_cluster.status`) — never refreshed after. */
		status: string;
		/** What the console has OBSERVED of the control plane since that deploy: a drift scan reporting
		 *  it deleted, a probe that could not reach it, or how fresh the reading behind `status` is
		 *  (lib/clusters/observed-state.ts, #6736). */
		observation: ControlPlaneObservation;
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
	/** Why a viewer who holds the permission cannot download right now (the mint would refuse), or null. */
	kubeconfig_download_note: string | null;
	/** The classification chips on this cluster (empty without `org:view`). */
	classification: AssignedValue[];
	/** The id of the newest plan, deploy or destroy job of the owning environment that the viewer
	 *  may see, or null — what "Last run failed" links to. */
	last_job_id: string | null;
}

/**
 * Every cluster under management in the actor's org, newest project first and, within a project,
 * its default environment's cluster first.
 *
 * Authorization: `project:view` (as the project list), then the read runs on the RLS-enforced app
 * role with the actor's own scope (`withActorScope`): clusters are org-shared, so the scope must
 * carry the real org — an owner scope would hide every cluster another member created.
 *
 * The org-wide `project:view` answers for the org, not for any one project: a grant or deny scoped
 * to a single project is part of the answer only when the PDP is asked about that project. So the
 * list also keeps only the clusters of projects the caller may view — the PDP's own deny-aware set
 * (`cliViewableProjectIds`, the set the CLI's `GET /api/cli/clusters` filters on) — as a second
 * predicate on `project_cluster.project_id`, after the org predicate. It narrows within the org; it
 * never widens it. Every console reader of this list (the Clusters page and the project drilldown
 * through `readClusterList`, the agent's `list_clusters` tool and the @-mention picker through
 * `getClusters`) gets the narrowed list, and what a page counts is this list's length, so its count
 * and its rows are one answer.
 *
 * The kubeconfig command per cluster comes from the same builder the CLI route serves; its reads run
 * concurrently inside this transaction rather than one after another per cluster.
 */
export async function readClusters(actor: Actor): Promise<ClusterData[]> {
	await getPdp().enforce(actor, "view", { type: "project" });
	const viewable = await cliViewableProjectIds(actor);

	return withActorScope(actor, async (tx) => {
		// The cluster's own placement wins over its project's (per-resource cloud placement, #5250 §5).
		const identityId = sql`coalesce(${projectCluster.cloud_identity_id}, ${projects.cloud_identity_id})`;
		const baseRows = await tx
			.select({
				id: projects.id,
				project_name: projects.project_name,
				project_slug: projects.slug,
				region: sql<string>`coalesce(${projectCluster.region}, ${projects.region})`,
				environment_stage: projectEnvironments.name,
				environment_status: projectEnvironments.status,
				environment_status_since: projectEnvironments.updated_at,
				environment_tier_stage: projectEnvironments.stage,
				last_deployed_at: projectEnvironments.last_deployed_at,
				provider: cloudIdentities.provider,
				cluster_id: projectCluster.id,
				cluster_created_at: projectCluster.created_at,
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
			// The org is the ADDRESS's, on the row's own tenant column — the column the Usage count, the
			// CLI's cluster list and the kubeconfig mint all scope on. RLS alone is wider: its owner arm
			// also admits the caller's personal-scope projects when the address names a team org.
			// Then visibility: only the projects the caller may view (`inArray` over an empty set
			// renders `false`, so a caller who may view no project lists no cluster).
			.where(
				and(
					eq(projectCluster.org_id, actor.orgId),
					inArray(projectCluster.project_id, viewable),
					managedClusterPredicate(),
				),
			)
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

		// What has been observed since each deploy (#6736) — read after the rows above, scoped to the
		// org and to the environments this caller's list already holds.
		const evidence = await readClusterEvidence(actor.orgId, envIds);
		const now = new Date();

		return baseRows.map((r, i) => {
			const envId = r.cluster_environment_id;
			const observation = observeControlPlane({
				lastDeployedAt: r.last_deployed_at?.toISOString() ?? null,
				stage: r.environment_tier_stage,
				drift: envId ? (evidence.drift.get(envId) ?? null) : null,
				probe: envId ? (evidence.probes.get(envId) ?? null) : null,
				now,
			});
			// A cluster a drift scan reports deleted gets no command: it would point at a cluster —
			// or a resource group — that is gone.
			const kubeconfig: KubeconfigAccess =
				observation.kind === "missing"
					? { command: null, alternative: null, note: KUBECONFIG_MISSING_CLUSTER_NOTE }
					: kubeconfigs[i];
			return {
				id: r.id,
				project_name: r.project_name,
				project_slug: r.project_slug,
				region: r.region,
				environment_id: envId,
				environment_stage: r.environment_stage,
				status: r.environment_status,
				status_since: r.environment_status_since.toISOString(),
				cloud_identities: r.provider ? { provider: r.provider } : null,
				project_cluster: {
					id: r.cluster_id,
					created_at: r.cluster_created_at.toISOString(),
					cluster_name: r.cluster_name,
					cluster_endpoint: r.cluster_endpoint,
					cluster_arn: r.cluster_outputs?.arn ?? null,
					cluster_version: r.cluster_version,
					k8s_version: displayedK8sVersion(r.provider, r.cluster_version),
					argocd_url: r.argocd_url,
					status: r.cluster_status,
					observation,
					kubeconfig,
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
			};
		});
	});
}

/**
 * The clusters `actor` holds `cluster:access_readonly` on — the action the download request itself
 * enforces — in ONE batched, non-recording check (`bulkCheck`: `can`, never `enforce`). Fail-closed:
 * a failed check is no download for any cluster. Asked only of clusters with an endpoint, the only
 * ones whose card offers the download.
 */
async function downloadableClusters(actor: Actor, clusters: ClusterData[]): Promise<Set<string>> {
	const ids = clusters.filter((c) => c.project_cluster.cluster_endpoint).map((c) => c.project_cluster.id);
	if (ids.length === 0) return new Set();
	const checks: BulkCheck[] = ids.map((id) => ({ action: "access_readonly", resource: { type: "cluster", id } }));
	const decisions = await getPdp()
		.bulkCheck(actor, checks)
		.catch((): Decision[] => []);
	return new Set(ids.filter((_id, i) => decisions[i]?.allowed === true));
}

/**
 * The classification chips of every cluster, in one batched read. Chips need `org:view`; without it
 * the clusters still render, chipless. It labels exactly the clusters `readClusters` returns, and
 * that list already leaves out the clusters of projects the viewer may not view — the same narrowing
 * the chips' own read (`classification.assignmentsForKind`, lib/rpc/procedures/classification.ts,
 * through `classifiedIdsViewable`) applies — so it asks no second visibility question.
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
 * The newest plan, deploy or destroy job of each cluster's environment, keyed by environment id, in
 * one read on the RLS-enforced app role: a job the viewer may not see is not linked. A failed read
 * is no link for any cluster, never a failed page.
 */
async function lastRunJobs(actor: Actor, clusters: ClusterData[]): Promise<Map<string, string>> {
	const envIds = [...new Set(clusters.map((c) => c.environment_id).filter((x): x is string => Boolean(x)))];
	const byEnv = new Map<string, string>();
	if (envIds.length === 0) return byEnv;
	try {
		// One row per environment: `distinct on` keeps the first of each, and the order makes that
		// the newest.
		const rows = await withActorScope(actor, async (tx) =>
			tx
				.selectDistinctOn([jobs.environment_id], { environment_id: jobs.environment_id, job_id: jobs.id })
				.from(jobs)
				.where(
					and(
						eq(jobs.org_id, actor.orgId),
						inArray(jobs.environment_id, envIds),
						inArray(jobs.job_type, ["PLAN", "DEPLOY", "DESTROY"]),
					),
				)
				.orderBy(jobs.environment_id, desc(jobs.created_at)),
		);
		for (const row of rows) {
			if (row.environment_id) byEnv.set(row.environment_id, row.job_id);
		}
	} catch {
		// No link is the answer; the clusters themselves have been read.
	}
	return byEnv;
}

/**
 * The Clusters page's read: every cluster under management, plus — so a card paints complete with no
 * request of its own (RUBRIC B1) — whether the viewer may download its kubeconfig and its
 * classification chips.
 */
export async function readClusterList(actor: Actor): Promise<ClusterListItem[]> {
	const clusters = await readClusters(actor);
	const [downloadable, chips, lastJobs] = await Promise.all([
		downloadableClusters(actor, clusters),
		clusterChips(actor, clusters),
		lastRunJobs(actor, clusters),
	]);
	return clusters.map((c) => {
		const permitted = downloadable.has(c.project_cluster.id);
		// The mint refuses an environment with an undeployed plan or a teardown in flight, even over a
		// live cluster; say so to a viewer who could otherwise download, rather than offer a button
		// the request will refuse.
		const refused = MINT_UNPROVISIONED_ENV_STATUSES.has(c.status);
		// A cluster a drift scan reports deleted has nothing to mint for; its kubeconfig note says why.
		const missing = c.project_cluster.observation.kind === "missing";
		return {
			...c,
			can_download_kubeconfig: permitted && !refused && !missing,
			kubeconfig_download_note:
				permitted && refused && !missing ? KUBECONFIG_MINT_UNPROVISIONED_REASON : null,
			classification: chips.get(c.project_cluster.id) ?? [],
			last_job_id: c.environment_id ? (lastJobs.get(c.environment_id) ?? null) : null,
		};
	});
}

const values = z.array(z.string().min(1).max(200)).max(200).optional();

/**
 * The clusters list's query: the route's scope and the bar's filters. Normalized (trimmed, sorted,
 * empty → absent) by the caller, so equal views are one query key.
 */
const clustersListQuery = z.object({
	/** The project a project route lists; absent on the org route. A SCOPE, never a filter. */
	projectId: z.uuid().optional(),
	search: z.string().max(200).optional(),
	clouds: values,
	statuses: values,
	regions: values,
});

/** One keyset page of the clusters list: the query plus the opaque cursor and the page size. */
export const clustersPageInput = clustersListQuery.extend(keysetPageInput());

/** What the clusters list is asked, without the paging fields — the normalized query, and the key. */
export type ClustersListQuery = z.infer<typeof clustersListQuery>;

/** The validated shape of {@link clustersPageInput} (the cursor decoded, the limit defaulted). */
export type ClustersPageInput = z.infer<typeof clustersPageInput>;

/**
 * One keyset page of the clusters list for `input`: the composed universe of
 * {@link readClusterList}, resolved and paged IN MEMORY on the server by `queryClustersPage`
 * (lib/queries/clusters.ts) — the scope on the rows and the facets, the filters on the rows only.
 * A project id of another organization, or of a project the viewer may not see, matches no row of
 * the universe and so lists nothing.
 */
export async function readClustersPage(
	actor: Actor,
	input: ClustersListQuery & Partial<Pick<ClustersPageInput, "cursor" | "limit">> = {},
): Promise<ClustersPage<ClusterListItem>> {
	const { projectId, cursor, limit = KEYSET_DEFAULT_LIMIT, ...filters } = input;
	return queryClustersPage(await readClusterList(actor), filters, { projectId }, { cursor, limit });
}

/**
 * The clusters domain's reads (ADR 0005 D1, #6122), resolved for the actor the entry point bound
 * from the request's ADDRESS — never the session's org. `page` serves `/~/clusters` and a project's
 * Clusters page: the filter standard's server half, scoped by the route. `list` is the whole
 * universe in one answer; no console page reads it since both routes moved to `page`.
 */
export const clustersRouter = {
	list: query.handler(({ context }) => readClusterList(context.actor)),
	page: query
		.input(clustersPageInput)
		.handler(({ context, input }) => readClustersPage(context.actor, input)),
};
