"use client";

import type { DatabaseEntry, CacheEntry } from "./plant-vine-form";
import type { RegionPrices } from "@/app/server/actions/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Loader2 } from "lucide-react";
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
	prices: RegionPrices | null;
	loadingPrices: boolean;
}

const HOURS_PER_MONTH = 730;

export function CostSidebar({
	databases,
	caches,
	cloudfrontWaf,
	applicationWaf,
	instanceTypes,
	nodeDesiredSize,
	singleNatGateway,
	prices,
	loadingPrices,
}: Props) {
	const items = useMemo(() => {
		const p = prices;
		const result: Array<{ label: string; cost: number; detail?: string }> = [];

		const eksHr = p?.eksControlPlane ?? 0.10;
		result.push({ label: "EKS Control Plane", cost: eksHr * HOURS_PER_MONTH });

		const avgHr = instanceTypes.length > 0
			? instanceTypes.reduce((sum, t) => sum + (p?.ec2[t] ?? 0.0456), 0) / instanceTypes.length
			: 0.0456;
		const nodeCost = avgHr * nodeDesiredSize * HOURS_PER_MONTH;
		const nodeLabel = instanceTypes.length > 0
			? `${nodeDesiredSize}x ${instanceTypes[0]}${instanceTypes.length > 1 ? ` +${instanceTypes.length - 1}` : ""}`
			: `${nodeDesiredSize} nodes`;
		result.push({ label: "EKS Nodes", cost: nodeCost, detail: nodeLabel });

		const natHr = p?.natGateway ?? 0.048;
		const natCount = singleNatGateway ? 1 : 3;
		result.push({
			label: "NAT Gateway",
			cost: natHr * HOURS_PER_MONTH * natCount,
			detail: singleNatGateway ? "single" : "per-AZ",
		});

		const acuHr = p?.auroraACU ?? 0.14;
		for (const db of databases) {
			result.push({
				label: `DB: ${db.name || "unnamed"}`,
				cost: db.min_capacity * acuHr * HOURS_PER_MONTH,
				detail: `${db.min_capacity}-${db.max_capacity} ACU`,
			});
		}

		for (const cache of caches) {
			const cacheHr = p?.cache[cache.node_type] ?? 0.058;
			result.push({
				label: `Cache: ${cache.name || "unnamed"}`,
				cost: cacheHr * cache.num_cache_nodes * HOURS_PER_MONTH,
				detail: `${cache.num_cache_nodes}x ${cache.node_type.replace("cache.", "")}`,
			});
		}

		const wafCost = p?.wafWebACL ?? 5.0;
		if (cloudfrontWaf) result.push({ label: "CloudFront WAF", cost: wafCost });
		if (applicationWaf) result.push({ label: "Application WAF", cost: wafCost });

		return result;
	}, [databases, caches, cloudfrontWaf, applicationWaf, instanceTypes, nodeDesiredSize, singleNatGateway, prices]);

	const total = items.reduce((sum, item) => sum + item.cost, 0);

	return (
		<div className="sticky top-20">
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<DollarSign className="h-4 w-4 text-muted-foreground" />
							<CardTitle className="text-sm">Estimated Cost</CardTitle>
						</div>
						{loadingPrices && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
					</div>
					<p className="text-[10px] text-muted-foreground">
						{prices
							? `Real prices for ${prices.region}`
							: "Select a region for real prices"}
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
