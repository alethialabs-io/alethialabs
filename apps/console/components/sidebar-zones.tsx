"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useZonesStore } from "@/lib/stores/use-zones-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { specHref, zoneHref } from "@/lib/routing";
import { SidebarZoneActions } from "@/components/sidebar-zone-actions";
import { ProviderIcon } from "@/components/provider-icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { ChevronRight, Map, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Sidebar section showing zones as a collapsible tree with spec sub-items. */
export function SidebarZones() {
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const {
		zones,
		isLoading,
		expandedIds,
		fetchZones,
		toggleExpanded,
		expandZone,
	} = useZonesStore();

	useEffect(() => {
		fetchZones();
	}, [fetchZones]);

	const segs = pathname.split("/").filter(Boolean);
	/** A zone's hrefs match either the slug path `/{org}/{zone}` or legacy `/dashboard/zones/{id}`. */
	const zoneMatches = (z: { id: string; slug: string | null }) =>
		(segs[0] !== "dashboard" && !!z.slug && segs[1] === z.slug) ||
		pathname.startsWith(`/dashboard/zones/${z.id}`);

	/** Auto-expand the zone matching the current path (without collapsing others). */
	useEffect(() => {
		for (const zone of zones) {
			if (zoneMatches(zone)) expandZone(zone.id);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pathname, zones, expandZone]);

	const expandedSet = new Set(expandedIds);

	return (
		<section className="mt-4">
			<p className="px-3 mb-2 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
				Zones
			</p>

			{isLoading && zones.length === 0 ? (
				<div className="space-y-1.5 px-3">
					<div className="h-8 w-full bg-muted rounded animate-pulse" />
					<div className="h-8 w-full bg-muted rounded animate-pulse" />
				</div>
			) : zones.length === 0 ? (
				<div className="px-3 space-y-2">
					<p className="text-xs text-muted-foreground italic">No zones yet</p>
					<Link href="/dashboard/design-spec" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
						<Plus className="h-3 w-3" />
						Create a Spec
					</Link>
				</div>
			) : (
				<div className="space-y-0.5">
					{zones.map((zone) => {
						const specs = zone.specs ?? [];
						const isExpanded = expandedSet.has(zone.id);
						const zoneSlugHref = zone.slug
							? zoneHref(orgSlug, zone.slug)
							: `/dashboard/zones/${zone.id}`;
						const isZoneActive =
							pathname === zoneSlugHref ||
							pathname === `/dashboard/zones/${zone.id}`;

						return (
							<div key={zone.id}>
								{/* Zone row */}
								<div className="group/zone flex items-center">
									<button
										type="button"
										onClick={() => toggleExpanded(zone.id)}
										className="p-1.5 ml-1 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted/40"
									>
										<ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
									</button>
									<Link
										href={zoneSlugHref}
										className="flex-1 min-w-0"
									>
										<div className={cn(
											"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
											isZoneActive
												? "bg-muted/80 text-foreground"
												: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
										)}>
											<Map className="h-3.5 w-3.5 shrink-0" />
											<span className="truncate">{zone.name}</span>
											<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
												{specs.length}
											</span>
										</div>
									</Link>
									<SidebarZoneActions
										zoneId={zone.id}
										zoneName={zone.name}
										specCount={specs.length}
									/>
								</div>

								{/* Spec sub-items */}
								{isExpanded && specs.length > 0 && (
									<div className="ml-6 pl-3 border-l border-border/40 space-y-0.5 py-0.5">
										{specs.map((spec) => {
											const specSlugHref =
												zone.slug && spec.slug
													? specHref(orgSlug, zone.slug, spec.slug)
													: `/dashboard/zones/${zone.id}/specs/${spec.id}`;
											const isSpecActive =
												pathname === specSlugHref ||
												pathname ===
													`/dashboard/zones/${zone.id}/specs/${spec.id}`;
											const hasProvider = !!spec.cloud_provider;

											return (
												<Link key={spec.id} href={specSlugHref}>
													<div className={cn(
														"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
														isSpecActive
															? "bg-muted/80 text-foreground"
															: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
													)}>
														<StatusBadge status={spec.status} showLabel={false} className="shrink-0" />
														<span className="truncate flex-1">{spec.project_name}</span>
														{hasProvider && (
															<ProviderIcon
																provider={spec.cloud_provider!}
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
