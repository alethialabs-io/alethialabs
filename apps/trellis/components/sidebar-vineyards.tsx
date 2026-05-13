"use client";

import { getVineyards, GetVineyardsData } from "@/app/server/actions/vineyards";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Map } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

function getStatusColor(status: string | null): string {
	switch (status) {
		case "completed":
			return "bg-emerald-500";
		case "provisioning":
			return "bg-amber-500";
		case "failed":
			return "bg-destructive";
		case "draft":
		default:
			return "bg-muted-foreground/40";
	}
}

export function SidebarVineyards() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const activeConfigId = searchParams.get("config_id");

	const [vineyards, setVineyards] = useState<GetVineyardsData>([]);
	const [loading, setLoading] = useState(true);
	const [openIds, setOpenIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		async function fetchVineyards() {
			try {
				const { vineyards } = await getVineyards();
				setVineyards(vineyards);

				// Auto-open vineyard that contains the active config
				if (activeConfigId) {
					const match = vineyards.find((v) =>
						v.configurations?.some((c) => c.id === activeConfigId),
					);
					if (match) {
						setOpenIds((prev) => new Set(prev).add(match.id));
					}
				}
			} catch (err) {
				console.error("Failed to fetch vineyards:", err);
			} finally {
				setLoading(false);
			}
		}

		fetchVineyards();
	}, [activeConfigId]);

	function toggleOpen(id: string) {
		setOpenIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}

	return (
		<section className="mt-4">
			<p className="px-3 mb-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
				Vineyards
			</p>

			{loading ? (
				<div className="space-y-1.5 px-3">
					<div className="h-7 w-full bg-muted rounded animate-pulse" />
					<div className="h-7 w-full bg-muted rounded animate-pulse" />
					<div className="h-7 w-full bg-muted rounded animate-pulse" />
				</div>
			) : vineyards.length === 0 ? (
				<p className="px-3 text-xs text-muted-foreground italic">
					No vineyards yet
				</p>
			) : (
				<div className="space-y-0.5">
					{vineyards.map((vineyard) => {
						const isOpen = openIds.has(vineyard.id);
						const configs = vineyard.configurations ?? [];

						return (
							<Collapsible
								key={vineyard.id}
								open={isOpen}
								onOpenChange={() => toggleOpen(vineyard.id)}
							>
								<CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
									<Map className="h-3.5 w-3.5 shrink-0" />
									<span className="flex-1 truncate text-left">
										{vineyard.name}
									</span>
									<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
										{configs.length}
									</span>
									{isOpen ? (
										<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									) : (
										<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									)}
								</CollapsibleTrigger>

								<CollapsibleContent>
									<div className="ml-3 border-l border-border/40 pl-3 py-1 space-y-0.5">
										{configs.length === 0 ? (
											<p className="px-2 py-1 text-xs text-muted-foreground italic">
												No vines
											</p>
										) : (
											configs.map((config) => {
												const isActive =
													pathname === "/dashboard/vines" &&
													activeConfigId === config.id;

												return (
													<Link
														key={config.id}
														href={`/dashboard/vines?config_id=${config.id}`}
													>
														<div
															className={cn(
																"flex items-center gap-2 rounded-md px-2 py-1 transition-colors",
																isActive
																	? "bg-muted/80 text-foreground"
																	: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
															)}
														>
															<span
																className={cn(
																	"h-1.5 w-1.5 shrink-0 rounded-full",
																	getStatusColor(config.status),
																)}
															/>
															<span className="text-xs truncate">
																{config.project_name}
															</span>
														</div>
													</Link>
												);
											})
										)}
									</div>
								</CollapsibleContent>
							</Collapsible>
						);
					})}
				</div>
			)}
		</section>
	);
}
