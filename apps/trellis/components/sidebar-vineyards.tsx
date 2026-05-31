"use client";

import { getVineyards, type GetVineyardsData } from "@/app/server/actions/vineyards";
import { getProvider } from "@/lib/cloud-providers";
import { cn } from "@/lib/utils";
import { ChevronRight, Map, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const STATUS_DOTS: Record<string, string> = {
	ACTIVE: "bg-emerald-500",
	DRAFT: "bg-muted-foreground/40",
	QUEUED: "bg-blue-500",
	PROVISIONING: "bg-amber-500",
	FAILED: "bg-destructive",
	DESTROYING: "bg-orange-500",
	DESTROYED: "bg-muted-foreground/20",
};

/** Sidebar section showing vineyards as a collapsible tree with vine sub-items. */
export function SidebarVineyards() {
	const pathname = usePathname();
	const [vineyards, setVineyards] = useState<GetVineyardsData>([]);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		getVineyards()
			.then(({ vineyards: data }) => {
				setVineyards(data);

				const autoExpand = new Set<string>();
				for (const vy of data) {
					if (pathname.startsWith(`/dashboard/vineyards/${vy.id}`)) {
						autoExpand.add(vy.id);
					}
				}
				if (autoExpand.size > 0) setExpanded(autoExpand);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [pathname]);

	const toggleExpand = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<section className="mt-4">
			<p className="px-3 mb-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
				Vineyards
			</p>

			{loading ? (
				<div className="space-y-1.5 px-3">
					<div className="h-7 w-full bg-muted rounded animate-pulse" />
					<div className="h-7 w-full bg-muted rounded animate-pulse" />
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
						const isExpanded = expanded.has(vineyard.id);
						const isVineyardActive = pathname === `/dashboard/vineyards/${vineyard.id}`;

						return (
							<div key={vineyard.id}>
								{/* Vineyard row */}
								<div className="flex items-center">
									<button
										type="button"
										onClick={() => toggleExpand(vineyard.id)}
										className="p-1 ml-1 text-muted-foreground hover:text-foreground transition-colors"
									>
										<ChevronRight className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")} />
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
								</div>

								{/* Vine sub-items */}
								{isExpanded && vines.length > 0 && (
									<div className="ml-5 pl-3 border-l border-border/40 space-y-0.5 py-0.5">
										{vines.map((vine) => {
											const isVineActive = pathname === `/dashboard/vineyards/${vineyard.id}/vines/${vine.id}`;
											const providerMeta = vine.cloud_provider ? getProvider(vine.cloud_provider) : null;

											return (
												<Link
													key={vine.id}
													href={`/dashboard/vineyards/${vineyard.id}/vines/${vine.id}`}
												>
													<div className={cn(
														"flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
														isVineActive
															? "bg-muted/80 text-foreground"
															: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
													)}>
														<span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOTS[vine.status] ?? "bg-muted-foreground/40")} />
														<span className="truncate flex-1">{vine.project_name}</span>
														{providerMeta && (
															<Image
																src={providerMeta.icon}
																alt={providerMeta.shortName}
																width={12}
																height={12}
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
