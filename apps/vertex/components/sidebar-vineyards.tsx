"use client";

import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";
import { VineyardActions } from "@/components/sidebar-vineyard-actions";
import { ProviderIcon } from "@/components/provider-icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { ChevronRight, Map, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Sidebar section showing vineyards as a collapsible tree with vine sub-items. */
export function SidebarVineyards() {
	const pathname = usePathname();
	const {
		vineyards,
		isLoading,
		expandedIds,
		fetchVineyards,
		toggleExpanded,
		expandVineyard,
	} = useVineyardsStore();

	useEffect(() => {
		fetchVineyards();
	}, [fetchVineyards]);

	/** Auto-expand the vineyard matching the current path (without collapsing others). */
	useEffect(() => {
		for (const vy of vineyards) {
			if (pathname.startsWith(`/dashboard/vineyards/${vy.id}`)) {
				expandVineyard(vy.id);
			}
		}
	}, [pathname, vineyards, expandVineyard]);

	const expandedSet = new Set(expandedIds);

	return (
		<section className="mt-4">
			<p className="px-3 mb-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
				Vineyards
			</p>

			{isLoading && vineyards.length === 0 ? (
				<div className="space-y-1.5 px-3">
					<div className="h-8 w-full bg-muted rounded animate-pulse" />
					<div className="h-8 w-full bg-muted rounded animate-pulse" />
				</div>
			) : vineyards.length === 0 ? (
				<div className="px-3 space-y-2">
					<p className="text-xs text-muted-foreground italic">No vineyards yet</p>
					<Link href="/dashboard/plant" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
						<Plus className="h-3 w-3" />
						Plant a Vine
					</Link>
				</div>
			) : (
				<div className="space-y-0.5">
					{vineyards.map((vineyard) => {
						const vines = vineyard.vines ?? [];
						const isExpanded = expandedSet.has(vineyard.id);
						const isVineyardActive = pathname === `/dashboard/vineyards/${vineyard.id}`;

						return (
							<div key={vineyard.id}>
								{/* Vineyard row */}
								<div className="group/vineyard flex items-center">
									<button
										type="button"
										onClick={() => toggleExpanded(vineyard.id)}
										className="p-1.5 ml-1 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted/40"
									>
										<ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
									</button>
									<Link
										href={`/dashboard/vineyards/${vineyard.id}`}
										className="flex-1 min-w-0"
									>
										<div className={cn(
											"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
											isVineyardActive
												? "bg-muted/80 text-foreground"
												: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
										)}>
											<Map className="h-3.5 w-3.5 shrink-0" />
											<span className="truncate">{vineyard.name}</span>
											<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
												{vines.length}
											</span>
										</div>
									</Link>
									<VineyardActions
										vineyardId={vineyard.id}
										vineyardName={vineyard.name}
										vineCount={vines.length}
									/>
								</div>

								{/* Vine sub-items */}
								{isExpanded && vines.length > 0 && (
									<div className="ml-6 pl-3 border-l border-border/40 space-y-0.5 py-0.5">
										{vines.map((vine) => {
											const isVineActive = pathname === `/dashboard/vineyards/${vineyard.id}/vines/${vine.id}`;
											const hasProvider = !!vine.cloud_provider;

											return (
												<Link
													key={vine.id}
													href={`/dashboard/vineyards/${vineyard.id}/vines/${vine.id}`}
												>
													<div className={cn(
														"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
														isVineActive
															? "bg-muted/80 text-foreground"
															: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
													)}>
														<StatusBadge status={vine.status} showLabel={false} className="shrink-0" />
														<span className="truncate flex-1">{vine.project_name}</span>
														{hasProvider && (
															<ProviderIcon
																provider={vine.cloud_provider!}
																size={14}
																className="shrink-0 opacity-50"
															/>
														)}
													</div>
												</Link>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
