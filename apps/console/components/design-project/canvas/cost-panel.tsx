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
		<div className="w-72 rounded-none border border-border bg-card/95 shadow-[0_1px_2px_rgba(0,0,0,0.06)] backdrop-blur">
			<div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
				<div className="flex items-center gap-2">
					<DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
					<span className="vx-eyebrow">Monthly estimate</span>
				</div>
				{loadingPrices && (
					<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
				)}
			</div>

			{items.length === 0 ? (
				<div className="px-3.5 py-4 text-xs text-muted-foreground">
					Add services to estimate cost.
				</div>
			) : (
				<div className="max-h-72 divide-y divide-border/50 overflow-y-auto">
					{items.map((item) => (
						<div
							key={item.label}
							className="flex items-center justify-between gap-2 px-3.5 py-2 text-xs"
						>
							<div className="flex min-w-0 items-center gap-1.5">
								<span className="truncate text-text-secondary">{item.label}</span>
								{item.detail && (
									<Badge
										variant="outline"
										className="shrink-0 rounded-none px-1 py-0 font-mono text-[9px] font-normal text-muted-foreground"
									>
										{item.detail}
									</Badge>
								)}
							</div>
							<span className="shrink-0 font-mono tabular-nums text-foreground">
								${item.cost.toFixed(0)}
							</span>
						</div>
					))}
				</div>
			)}

			<div className="flex items-baseline justify-between border-t border-border px-3.5 py-2.5">
				<span className="text-[13px] font-medium">Total</span>
				<span className="font-mono text-sm font-semibold tabular-nums">
					~${total.toFixed(0)}
					<span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
						/mo
					</span>
				</span>
			</div>
		</div>
	);
}
