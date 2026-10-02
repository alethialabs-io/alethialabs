// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";
import { asCloudProviderSlug, getProvider } from "@/lib/cloud-providers/provider-slug";
import type {
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectNetwork,
} from "@/lib/db/schema/project-components";
import type { RegionPrices } from "@/lib/pricing/region-prices";
import { type CostItem, type CostMeta, computeCostItems } from "./compute-cost-items";

/**
 * The estimate's labels and cloud for a cluster on `clusterProvider` in a project on
 * `projectProvider` (#5361). The cluster's lines — control plane and nodes — are priced and named
 * on the CLUSTER's cloud, because that is where the deploy puts it; the secrets line stays the
 * project's. Every caller of computeCostItems that knows both clouds builds its meta here.
 */
export function clusterCostMeta(
	clusterProvider: CloudProviderSlug,
	projectProvider: CloudProviderSlug,
): CostMeta {
	return {
		clusterService: getProvider(clusterProvider).clusterService,
		secretsService: getProvider(projectProvider).secretsService,
		provider: clusterProvider,
	};
}

type Row<T extends { $inferSelect: object }> = T["$inferSelect"];

/** The slice of `getProject`'s answer the artifact panel's estimate reads. */
export interface ProjectCostSource {
	/** The project's cloud (its own identity's provider). */
	cloudProvider: string;
	/** The env cluster's cloud: coalesce(cluster identity, project identity) → provider. */
	clusterCloudProvider: string;
	components: {
		cluster: Pick<
			Row<typeof projectCluster>,
			"instance_types" | "node_size" | "capacity_type" | "node_desired_size"
		> | null;
		network: Pick<Row<typeof projectNetwork>, "single_nat_gateway"> | null;
		dns: Pick<Row<typeof projectDns>, "waf_enabled"> | null;
		databases: Array<Pick<Row<typeof projectDatabases>, "name" | "min_capacity" | "max_capacity">>;
		caches: Array<Pick<Row<typeof projectCaches>, "name" | "node_type" | "num_cache_nodes">>;
		nosql_tables: readonly unknown[];
		secrets: readonly unknown[];
	};
}

/**
 * A project's monthly estimate as the agent's artifact panel shows it. The cluster is priced on
 * ITS OWN cloud — a gcp-identity cluster in an aws project buys a gcp machine, so it is resolved
 * and priced on gcp (#5361) — while the project-wide lines keep the project's cloud.
 */
export function estimateProjectCost(
	detail: ProjectCostSource,
	prices: RegionPrices | null,
): { items: CostItem[]; total: number } {
	const c = detail.components.cluster;
	const n = detail.components.network;
	// All five clouds, not three: the slug also decides what an EMPTY instance list is priced as
	// (#5251), so folding hetzner/alibaba into "aws" would price them as aws's default node.
	const meta = clusterCostMeta(
		asCloudProviderSlug(detail.clusterCloudProvider),
		asCloudProviderSlug(detail.cloudProvider),
	);
	return computeCostItems(
		{
			instanceTypes: c?.instance_types ?? [],
			nodeSize: c?.node_size ?? null,
			capacityType: c?.capacity_type ?? null,
			nodeDesiredSize: c?.node_desired_size ?? 2,
			singleNatGateway: n?.single_nat_gateway ?? true,
			databases: detail.components.databases.map((d) => ({
				name: d.name,
				min_capacity: d.min_capacity,
				max_capacity: d.max_capacity,
			})),
			caches: detail.components.caches.map((ch) => ({
				name: ch.name,
				node_type: ch.node_type,
				num_cache_nodes: ch.num_cache_nodes,
			})),
			cloudfrontWaf: false,
			applicationWaf: detail.components.dns?.waf_enabled ?? false,
			nosqlCount: detail.components.nosql_tables.length,
			secretsCount: detail.components.secrets.length,
		},
		prices,
		meta,
	);
}
