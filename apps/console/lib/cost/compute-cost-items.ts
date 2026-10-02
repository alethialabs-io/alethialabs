// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	INSTANCE_TYPES,
	type CloudProviderSlug,
} from "@/lib/cloud-providers/generated/catalog";
import { describeNodeShape, resolveInstanceTypes } from "@/lib/cloud-providers/node-sizing";
import type { NodeCapacityType } from "@/lib/db/schema/enums";
import type { RegionPrices } from "@/lib/pricing/region-prices";
import type { NodeSize } from "@/types/jsonb.types";
import { TEMPLATE_DEFAULT_NODE } from "./template-default-node";

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

/** USD/hour from a catalog cost hint (`~$98/mo`, hetzner's `~€8/mo` taken at par); null without one. */
function catalogHourly(provider: CloudProviderSlug, sku: string): number | null {
	const hint = INSTANCE_TYPES[provider].find((i) => i.value === sku)?.cost;
	const monthly = hint?.match(/(\d+(?:\.\d+)?)/)?.[1];
	return monthly ? Number(monthly) / HOURS_PER_MONTH : null;
}

/**
 * The hourly rate of one machine type on `provider`: the live (AWS) price table first, then the
 * AWS fallback table, then the catalog's own cost hint for that cloud's SKU. The last resort is the
 * estimate's historical flat rate, reached only by an SKU that no table and no catalog entry knows.
 */
function nodeHourly(
	sku: string,
	provider: CloudProviderSlug,
	prices: RegionPrices | null,
): number {
	return prices?.ec2[sku] ?? FALLBACK_EC2[sku] ?? catalogHourly(provider, sku) ?? 0.0456;
}

export interface CostItem {
	label: string;
	cost: number;
	detail?: string;
}

/** The slice of project config the estimate needs. */
export interface CostInput {
	/** The cluster's pinned machine types (`instance_types`). A non-empty list wins over `nodeSize`. */
	instanceTypes: string[];
	/**
	 * The cluster's portable size (`node_size`). With no pinned type it is priced at the SKU it
	 * resolves to on `meta.provider` — the same resolution the cluster card shows (#5291).
	 */
	nodeSize?: NodeSize | null;
	/** The node pool's purchase option. The price table is on-demand only, so Spot is noted, not priced. */
	capacityType?: NodeCapacityType | null;
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

/** Provider-specific labels, plus the cloud — which decides what an EMPTY instance list buys. */
export interface CostMeta {
	clusterService: string;
	secretsService: string;
	/** The cluster's cloud. An empty `instanceTypes` is priced at THIS cloud's template default. */
	provider: CloudProviderSlug;
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

	const { nodeDesiredSize } = input;
	// The machine the deploy buys, resolved exactly as the cluster card resolves it (#5291): a pinned
	// type wins, otherwise node_size's nearest catalog SKU on this cloud. Both go through
	// node-sizing.ts, so the estimate and the card cannot name different machines.
	const sizing = { instance_types: input.instanceTypes, node_size: input.nodeSize ?? null };
	const machines = resolveInstanceTypes(meta.provider, sizing);
	// No machine at all means the template's own default, not a cheap guess (#5251). Since #5266 that
	// default equals the catalog's (on AWS a t3.large), so this prices the node that is bought.
	const templateDefault = TEMPLATE_DEFAULT_NODE[meta.provider];
	const avgHr =
		machines.length > 0
			? machines.reduce((sum, t) => sum + nodeHourly(t, meta.provider, p), 0) /
				machines.length
			: (p?.ec2[templateDefault.instanceType] ??
				FALLBACK_EC2[templateDefault.instanceType] ??
				templateDefault.fallbackHourly);
	const shapeLabel =
		machines.length > 0
			? `${nodeDesiredSize}x ${describeNodeShape(meta.provider, sizing)}${machines.length > 1 ? ` +${machines.length - 1}` : ""}`
			: `${nodeDesiredSize}x ${templateDefault.instanceType} (template default)`;
	// The price table carries on-demand rates only; a Spot pool is said to be priced on-demand
	// rather than given a discount nothing measured.
	const nodeLabel =
		input.capacityType === "spot" ? `${shapeLabel} · Spot, estimated at on-demand rates` : shapeLabel;
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
