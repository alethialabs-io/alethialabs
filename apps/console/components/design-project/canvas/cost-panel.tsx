"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DollarSign, Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Badge } from "@repo/ui/badge";
import { getProvider } from "@/lib/cloud-providers";
import { computeCostItems } from "@/lib/cost/compute-cost-items";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { usePricingStore } from "@/lib/stores/use-pricing-store";
import { graphToForm } from "./graph/graph-to-form";

type LooseConfig = Record<string, unknown>;
type DnsConfig = { provider_config?: { cloudfront_waf?: boolean; application_waf?: boolean } };

/** Canvas cost estimate — derives its input from the graph, reusing the form's math. */
export function CostPanel() {
	const nodes = useCanvasStore((s) => s.nodes);
	const coreProvider =
		useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID)) ?? "aws";
	const prices = usePricingStore((s) => s.prices);
	const loadingPrices = usePricingStore((s) => s.loadingPrices);
	const fetchPrices = usePricingStore((s) => s.fetchPrices);

	const form = useMemo(() => graphToForm(nodes), [nodes]);
	const meta = getProvider(coreProvider);

	const region = (form.project as LooseConfig | undefined)?.region as
		| string
		| undefined;
	useEffect(() => {
		if (region) fetchPrices(region);
	}, [region, fetchPrices]);

	const { items, total } = useMemo(() => {
		const cluster = (form.cluster ?? {}) as LooseConfig;
		const network = (form.network ?? {}) as LooseConfig;
		const dns = (form.dns ?? {}) as DnsConfig;
		return computeCostItems(
			{
				instanceTypes: (cluster.instance_types as string[]) ?? [],
				nodeDesiredSize: (cluster.node_desired_size as number) ?? 2,
				singleNatGateway: (network.single_nat_gateway as boolean) ?? true,
				databases: (form.databases as LooseConfig[]) ?? [],
				caches: (form.caches as LooseConfig[]) ?? [],
				cloudfrontWaf: dns.provider_config?.cloudfront_waf ?? false,
				applicationWaf: dns.provider_config?.application_waf ?? false,
				nosqlCount: ((form.nosql_tables as unknown[]) ?? []).length,
				secretsCount: ((form.secrets as unknown[]) ?? []).length,
			},
			prices,
			{ clusterService: meta.clusterService, secretsService: meta.secretsService },
		);
	}, [form, prices, meta]);

	return (
		<div className="w-64 border border-border bg-background/90 backdrop-blur">
			<div className="flex items-center justify-between border-b border-border px-3 py-2">
				<div className="flex items-center gap-2">
					<DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
					<span className="vx-eyebrow">Estimate</span>
				</div>
				{loadingPrices && (
					<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
				)}
			</div>
			<div className="max-h-64 space-y-1.5 overflow-y-auto px-3 py-2">
				{items.map((item) => (
					<div
						key={item.label}
						className="flex items-center justify-between text-xs"
					>
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="truncate text-muted-foreground">{item.label}</span>
							{item.detail && (
								<Badge
									variant="outline"
									className="shrink-0 rounded-none px-1 py-0 text-[9px]"
								>
									{item.detail}
								</Badge>
							)}
						</div>
						<span className="ml-2 shrink-0 font-mono text-foreground">
							${item.cost.toFixed(0)}
						</span>
					</div>
				))}
			</div>
			<div className="flex items-center justify-between border-t border-border px-3 py-2">
				<span className="text-sm font-medium">Total</span>
				<span className="font-mono text-sm font-semibold">
					~${total.toFixed(0)}/mo
				</span>
			</div>
		</div>
	);
}
