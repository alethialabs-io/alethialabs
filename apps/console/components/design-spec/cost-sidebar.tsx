"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useSpecStore } from "@/lib/stores/use-spec-store";
import { useProviderMeta } from "@/lib/cloud-providers";
import { computeCostItems } from "@/lib/cost/compute-cost-items";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useFormContext } from "react-hook-form";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";

export function CostSidebar() {
	const { watch } = useFormContext<SpecFormData>();
	const { prices, loadingPrices } = useSpecStore();
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

	const { items, total } = useMemo(
		() =>
			computeCostItems(
				{
					instanceTypes,
					nodeDesiredSize,
					singleNatGateway,
					databases,
					caches,
					cloudfrontWaf,
					applicationWaf,
					nosqlCount: nosqlTables.length,
					secretsCount: secrets.length,
				},
				prices,
				meta,
			),
		[databases, caches, cloudfrontWaf, applicationWaf, instanceTypes, nodeDesiredSize, singleNatGateway, prices, nosqlTables, secrets, meta],
	);

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
