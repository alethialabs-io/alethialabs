"use client";

import type { DatabaseEntry, CacheEntry } from "./plant-vine-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign } from "lucide-react";
import { useMemo } from "react";

interface Props {
	databases: DatabaseEntry[];
	caches: CacheEntry[];
	enableDns: boolean;
	cloudfrontWaf: boolean;
	applicationWaf: boolean;
	enableKarpenter: boolean;
	region: string;
	instanceTypes: string[];
	nodeDesiredSize: number;
	singleNatGateway: boolean;
}

const INSTANCE_PRICES: Record<string, number> = {
	"t3.medium": 0.0416,
	"t3.large": 0.0832,
	"t3.xlarge": 0.1664,
	"m5a.large": 0.086,
	"m5a.xlarge": 0.172,
	"m5a.2xlarge": 0.344,
	"m5a.4xlarge": 0.688,
	"c5.large": 0.085,
	"c5.xlarge": 0.17,
	"r5.large": 0.126,
	"r5.xlarge": 0.252,
};

const CACHE_PRICES: Record<string, number> = {
	"cache.t3.micro": 12.41,
	"cache.t3.small": 18.62,
	"cache.t3.medium": 24.82,
	"cache.r6g.large": 108.0,
};

export function CostSidebar({
	databases,
	caches,
	enableDns,
	cloudfrontWaf,
	applicationWaf,
	enableKarpenter,
	region,
	instanceTypes,
	nodeDesiredSize,
	singleNatGateway,
}: Props) {
	const items = useMemo(() => {
		const result: Array<{ label: string; cost: number; detail?: string }> = [];

		result.push({ label: "EKS Control Plane", cost: 73.0 });

		const avgInstancePrice =
			instanceTypes.length > 0
				? instanceTypes.reduce((sum, t) => sum + (INSTANCE_PRICES[t] || 0.0416), 0) / instanceTypes.length
				: 0.0416;
		const nodeCost = avgInstancePrice * nodeDesiredSize * 730;
		const nodeLabel = instanceTypes.length > 0
			? `${nodeDesiredSize}x ${instanceTypes[0]}${instanceTypes.length > 1 ? ` +${instanceTypes.length - 1}` : ""}`
			: `${nodeDesiredSize} nodes`;
		result.push({ label: "EKS Nodes", cost: nodeCost, detail: nodeLabel });

		const natCount = singleNatGateway ? 1 : 3;
		result.push({
			label: "NAT Gateway",
			cost: 32.85 * natCount,
			detail: singleNatGateway ? "single" : "per-AZ",
		});

		for (const db of databases) {
			const cost = db.min_capacity * 0.12 * 730;
			result.push({
				label: `DB: ${db.name || "unnamed"}`,
				cost,
				detail: `${db.min_capacity}-${db.max_capacity} ACU`,
			});
		}

		for (const cache of caches) {
			const price = CACHE_PRICES[cache.node_type] || 24.82;
			result.push({
				label: `Cache: ${cache.name || "unnamed"}`,
				cost: price * cache.num_cache_nodes,
				detail: `${cache.num_cache_nodes}x ${cache.node_type.replace("cache.", "")}`,
			});
		}

		if (cloudfrontWaf) result.push({ label: "CloudFront WAF", cost: 5.0 });
		if (applicationWaf) result.push({ label: "Application WAF", cost: 5.0 });

		return result;
	}, [databases, caches, cloudfrontWaf, applicationWaf, instanceTypes, nodeDesiredSize, singleNatGateway]);

	const total = items.reduce((sum, item) => sum + item.cost, 0);

	return (
		<div className="sticky top-20">
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<DollarSign className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-sm">Estimated Cost</CardTitle>
					</div>
					<p className="text-[10px] text-muted-foreground">
						Rough estimate. Actual costs vary by region and usage.
					</p>
				</CardHeader>
				<CardContent className="space-y-2">
					{items.map((item, i) => (
						<div key={i} className="flex items-center justify-between text-xs">
							<div className="flex items-center gap-1.5 min-w-0">
								<span className="text-muted-foreground truncate">{item.label}</span>
								{item.detail && (
									<Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
										{item.detail}
									</Badge>
								)}
							</div>
							<span className="font-mono text-foreground shrink-0 ml-2">
								${item.cost.toFixed(0)}
							</span>
						</div>
					))}

					<div className="border-t border-border/50 pt-2 mt-3">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Total</span>
							<span className="text-sm font-semibold font-mono">
								~${total.toFixed(0)}/mo
							</span>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
