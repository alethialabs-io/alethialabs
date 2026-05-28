"use client";

import { getVineyards, GetVineyardsData } from "@/app/server/actions/vineyards";
import { cn } from "@/lib/utils";
import { Map } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function SidebarVineyards() {
	const pathname = usePathname();

	const [vineyards, setVineyards] = useState<GetVineyardsData>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		async function fetchVineyards() {
			try {
				const { vineyards } = await getVineyards();
				setVineyards(vineyards);
			} catch (err) {
				console.error("Failed to fetch vineyards:", err);
			} finally {
				setLoading(false);
			}
		}

		fetchVineyards();
	}, []);

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
						const configs = vineyard.configurations ?? [];
						const isActive = pathname.startsWith(
							`/dashboard/vineyards/${vineyard.id}`,
						);

						return (
							<Link
								key={vineyard.id}
								href={`/dashboard/vineyards/${vineyard.id}`}
							>
								<div
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
										isActive
											? "bg-muted/80 text-foreground"
											: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
									)}
								>
									<Map className="h-3.5 w-3.5 shrink-0" />
									<span className="flex-1 truncate text-left">
										{vineyard.name}
									</span>
									<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
										{configs.length}
									</span>
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</section>
	);
}
