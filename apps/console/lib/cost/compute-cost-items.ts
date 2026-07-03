// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { RegionPrices } from "@/app/server/actions/pricing";

const HOURS_PER_MONTH = 730;

const FALLBACK_EC2: Record<string, number> = {
	"t3.medium": 0.0456, "t3.large": 0.0912, "t3.xlarge": 0.1824,
	"m5a.large": 0.096, "m5a.xlarge": 0.192, "m5a.2xlarge": 0.384, "m5a.4xlarge": 0.768,
	"c5.large": 0.096, "c5.xlarge": 0.192, "r5.large": 0.141, "r5.xlarge": 0.282,
	"g4dn.xlarge": 0.526, "p3.2xlarge": 3.06,
};

const FALLBACK_CACHE: Record<string, number> = {
	"cache.t3.micro": 0.014, "cache.t3.small": 0.029, "cache.t3.medium": 0.058, "cache.r6g.large": 0.183,
};

export interface CostItem {
	label: string;
	cost: number;
	detail?: string;
}

/** The slice of project config the estimate needs. */
export interface CostInput {
	instanceTypes: string[];
	nodeDesiredSize: number;
	singleNatGateway: boolean;
	databases: Array<{
		name?: string | null;
		min_capacity?: number | null;
		max_capacity?: number | null;
	}>;
	caches: Array<{
		name?: string | null;
		node_type?: string | null;
		num_cache_nodes?: number | null;
	}>;
	cloudfrontWaf: boolean;
	applicationWaf: boolean;
	nosqlCount: number;
	secretsCount: number;
}

/** Provider-specific labels (the math itself is provider-agnostic). */
export interface CostMeta {
	clusterService: string;
	secretsService: string;
}

/**
 * Pure monthly-cost estimate, extracted verbatim from CostSidebar so the form and
 * the canvas cost panel share one implementation. Prices may be null (loading /
 * error) — every line item falls back to a hardcoded rate.
 */
export function computeCostItems(
	input: CostInput,
	prices: RegionPrices | null,
	meta: CostMeta,
): { items: CostItem[]; total: number } {
	const p = prices;
	const result: CostItem[] = [];

	result.push({
		label: `${meta.clusterService} Control Plane`,
		cost: (p?.eksControlPlane ?? 0.1) * HOURS_PER_MONTH,
	});

	const { instanceTypes, nodeDesiredSize } = input;
	const avgHr =
		instanceTypes.length > 0
			? instanceTypes.reduce(
					(sum, t) => sum + (p?.ec2[t] ?? FALLBACK_EC2[t] ?? 0.0456),
					0,
				) / instanceTypes.length
			: 0.0456;
	const nodeLabel =
		instanceTypes.length > 0
			? `${nodeDesiredSize}x ${instanceTypes[0]}${instanceTypes.length > 1 ? ` +${instanceTypes.length - 1}` : ""}`
			: `${nodeDesiredSize} nodes`;
	result.push({
		label: `${meta.clusterService} Nodes`,
		cost: avgHr * nodeDesiredSize * HOURS_PER_MONTH,
		detail: nodeLabel,
	});

	const natCount = input.singleNatGateway ? 1 : 3;
	result.push({
		label: "NAT Gateway",
		cost: (p?.natGateway ?? 0.048) * HOURS_PER_MONTH * natCount,
		detail: input.singleNatGateway ? "single" : "per-AZ",
	});

	for (const db of input.databases) {
		const cost = (db.min_capacity ?? 0.5) * (p?.auroraACU ?? 0.14) * HOURS_PER_MONTH;
		result.push({
			label: `DB: ${db.name || "unnamed"}`,
			cost,
			detail: `${db.min_capacity ?? 0.5}-${db.max_capacity ?? 4} ACU`,
		});
	}

	for (const cache of input.caches) {
		const key = cache.node_type || "cache.t3.medium";
		const cacheHr = p?.cache[key] ?? FALLBACK_CACHE[key] ?? 0.058;
		result.push({
			label: `Cache: ${cache.name || "unnamed"}`,
			cost: cacheHr * (cache.num_cache_nodes ?? 1) * HOURS_PER_MONTH,
			detail: `${cache.num_cache_nodes ?? 1}x ${key.replace("cache.", "")}`,
		});
	}

	if (input.cloudfrontWaf)
		result.push({ label: "CDN WAF", cost: p?.wafWebACL ?? 5.0 });
	if (input.applicationWaf)
		result.push({ label: "Application WAF", cost: p?.wafWebACL ?? 5.0 });

	if (input.nosqlCount > 0) {
		result.push({
			label: "NoSQL",
			cost: 0,
			detail: `${input.nosqlCount} table${input.nosqlCount > 1 ? "s" : ""} (on-demand)`,
		});
	}

	if (input.secretsCount > 0) {
		result.push({
			label: meta.secretsService,
			cost: input.secretsCount * 0.4,
			detail: `${input.secretsCount} secret${input.secretsCount > 1 ? "s" : ""}`,
		});
	}

	const total = result.reduce((sum, item) => sum + item.cost, 0);
	return { items: result, total };
}
