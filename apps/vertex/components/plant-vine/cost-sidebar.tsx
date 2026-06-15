"use client";

import { useVineStore } from "@/lib/stores/use-vine-store";
import { useProviderMeta } from "@/lib/cloud-providers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

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

export function CostSidebar() {
	const { watch } = useFormContext<VineFormData>();
	const { prices, loadingPrices } = useVineStore();
	const meta = useProviderMeta();

	const instanceTypes = watch("cluster.instance_types") || [];
	const nodeDesiredSize = watch("cluster.node_desired_size") || 2;
	const singleNatGateway = watch("network.single_nat_gateway") ?? true;
	const databases = watch("databases") || [];
	const caches = watch("caches") || [];
	const cloudfrontWaf = watch("dns.provider_config.cloudfront_waf") ?? false;
	const applicationWaf = watch("dns.provider_config.application_waf") ?? false;
	const nosqlTables = watch("nosql_tables") || [];
	const secrets = watch("secrets") || [];

	const items = useMemo(() => {
		const p = prices;
		const result: Array<{ label: string; cost: number; detail?: string }> = [];

		result.push({ label: `${meta.clusterService} Control Plane`, cost: (p?.eksControlPlane ?? 0.10) * HOURS_PER_MONTH });

		const avgHr = instanceTypes.length > 0
			? instanceTypes.reduce((sum: number, t: string) => sum + (p?.ec2[t] ?? FALLBACK_EC2[t] ?? 0.0456), 0) / instanceTypes.length
			: 0.0456;
		const nodeLabel = instanceTypes.length > 0
			? `${nodeDesiredSize}x ${instanceTypes[0]}${instanceTypes.length > 1 ? ` +${instanceTypes.length - 1}` : ""}`
			: `${nodeDesiredSize} nodes`;
		result.push({ label: `${meta.clusterService} Nodes`, cost: avgHr * nodeDesiredSize * HOURS_PER_MONTH, detail: nodeLabel });

		const natCount = singleNatGateway ? 1 : 3;
		result.push({ label: "NAT Gateway", cost: (p?.natGateway ?? 0.048) * HOURS_PER_MONTH * natCount, detail: singleNatGateway ? "single" : "per-AZ" });

		for (const db of databases) {
			const cost = (db.min_capacity ?? 0.5) * (p?.auroraACU ?? 0.14) * HOURS_PER_MONTH;
			result.push({ label: `DB: ${db.name || "unnamed"}`, cost, detail: `${db.min_capacity ?? 0.5}-${db.max_capacity ?? 4} ACU` });
		}

		for (const cache of caches) {
			const cacheHr = p?.cache[cache.node_type || "cache.t3.medium"] ?? FALLBACK_CACHE[cache.node_type || "cache.t3.medium"] ?? 0.058;
			result.push({ label: `Cache: ${cache.name || "unnamed"}`, cost: cacheHr * (cache.num_cache_nodes ?? 1) * HOURS_PER_MONTH, detail: `${cache.num_cache_nodes ?? 1}x ${(cache.node_type || "cache.t3.medium").replace("cache.", "")}` });
		}

		if (cloudfrontWaf) result.push({ label: "CDN WAF", cost: p?.wafWebACL ?? 5.0 });
		if (applicationWaf) result.push({ label: "Application WAF", cost: p?.wafWebACL ?? 5.0 });

		if (nosqlTables.length > 0) {
			result.push({ label: "NoSQL", cost: 0, detail: `${nosqlTables.length} table${nosqlTables.length > 1 ? "s" : ""} (on-demand)` });
		}

		if (secrets.length > 0) {
			result.push({ label: `${meta.secretsService}`, cost: secrets.length * 0.40, detail: `${secrets.length} secret${secrets.length > 1 ? "s" : ""}` });
		}

		return result;
	}, [databases, caches, cloudfrontWaf, applicationWaf, instanceTypes, nodeDesiredSize, singleNatGateway, prices, nosqlTables, secrets]);

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
						{prices ? `Real prices for ${prices.region}` : "Select a region for real prices"}
					</p>
				</CardHeader>
				<CardContent className="space-y-2">
					{items.map((item, i) => (
						<div key={i} className="flex items-center justify-between text-xs">
							<div className="flex items-center gap-1.5 min-w-0">
								<span className="text-muted-foreground truncate">{item.label}</span>
								{item.detail && <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">{item.detail}</Badge>}
							</div>
							<span className="font-mono text-foreground shrink-0 ml-2">${item.cost.toFixed(0)}</span>
						</div>
					))}
					<div className="border-t border-border/50 pt-2 mt-3">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Total</span>
							<span className="text-sm font-semibold font-mono">~${total.toFixed(0)}/mo</span>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
