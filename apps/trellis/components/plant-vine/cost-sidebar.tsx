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
}

const NODE_PRICES: Record<string, number> = {
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
}: Props) {
	const items = useMemo(() => {
		const result: Array<{ label: string; cost: number; detail?: string }> = [];

		result.push({ label: "EKS Control Plane", cost: 73.0 });
		result.push({ label: "EKS Nodes (3x t3.medium)", cost: 91.98 });
		result.push({ label: "NAT Gateway", cost: 32.85 });

		for (const db of databases) {
			const cost = db.min_capacity * 0.12 * 730;
			result.push({
				label: `DB: ${db.name}`,
				cost,
				detail: `${db.min_capacity}-${db.max_capacity} ACU`,
			});
		}

		for (const cache of caches) {
			const price = NODE_PRICES[cache.node_type] || 24.82;
			result.push({
				label: `Cache: ${cache.name}`,
				cost: price * cache.num_cache_nodes,
				detail: cache.node_type.replace("cache.", ""),
			});
		}

		if (cloudfrontWaf) result.push({ label: "CloudFront WAF", cost: 5.0 });
		if (applicationWaf) result.push({ label: "Application WAF", cost: 5.0 });

		return result;
	}, [databases, caches, cloudfrontWaf, applicationWaf]);

	const total = items.reduce((sum, item) => sum + item.cost, 0);

	return (
		<div className="sticky top-20">
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<DollarSign className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-sm">Estimated Cost</CardTitle>
					</div>
				</CardHeader>
				<CardContent className="space-y-2">
					{items.map((item, i) => (
						<div key={i} className="flex items-center justify-between text-xs">
							<div className="flex items-center gap-1.5">
								<span className="text-muted-foreground">{item.label}</span>
								{item.detail && (
									<Badge variant="outline" className="text-[9px] px-1 py-0">
										{item.detail}
									</Badge>
								)}
							</div>
							<span className="font-mono text-foreground">
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
						<p className="text-[10px] text-muted-foreground mt-1">
							Based on default instance types. Actual costs may vary by region and usage.
						</p>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
