// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { getRegionPrices } from "@/app/server/actions/pricing";
import {
	DB_CAPACITY,
	DEFAULT_CACHE_NODE,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_REGION,
	getProvider,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { type CostItem, computeCostItems } from "@/lib/cost/compute-cost-items";
import type { InferredStack } from "./schema";

export interface ProviderCost {
	provider: CloudProviderSlug;
	region: string;
	monthly: number;
	items: CostItem[];
}

const PROVIDERS: CloudProviderSlug[] = ["aws", "gcp", "azure"];

/** A provider-default cost input for the inferred stack (counts → resources). */
function costInputForProvider(stack: InferredStack, provider: CloudProviderSlug) {
	const count = (kind: string) =>
		stack.needs.filter((n) => n.kind === kind).length;
	const cap = DB_CAPACITY[provider];
	return {
		instanceTypes: [DEFAULT_INSTANCE_TYPE[provider]],
		nodeDesiredSize: 2,
		singleNatGateway: true,
		databases: Array.from({ length: count("database") }, () => ({
			min_capacity: cap.defaultMin,
			max_capacity: cap.defaultMax,
		})),
		caches: Array.from({ length: count("cache") }, () => ({
			node_type: DEFAULT_CACHE_NODE[provider],
			num_cache_nodes: 1,
		})),
		cloudfrontWaf: false,
		applicationWaf: false,
		nosqlCount: count("nosql"),
		secretsCount: count("secret"),
	};
}

/**
 * Estimate the inferred stack's monthly cost on each cloud (cluster + nat + dbs +
 * caches + nosql + secrets), priced with live region prices where available (AWS) and
 * the cost model's fallback rates otherwise. Ranked cheapest-first.
 */
export async function compareProviders(
	stack: InferredStack,
): Promise<ProviderCost[]> {
	const results = await Promise.all(
		PROVIDERS.map(async (provider) => {
			const region = DEFAULT_REGION[provider];
			const prices = await getRegionPrices(region).catch(() => null);
			const meta = getProvider(provider);
			const { items, total } = computeCostItems(
				costInputForProvider(stack, provider),
				prices,
				{ clusterService: meta.clusterService, secretsService: meta.secretsService },
			);
			return { provider, region, monthly: Math.round(total), items };
		}),
	);
	return results.sort((a, b) => a.monthly - b.monthly);
}
