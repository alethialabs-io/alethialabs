"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Box, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useZonesStore } from "@/lib/stores/use-zones-store";
import { zoneHref } from "@/lib/routing";

/** Org landing — the org's zones, each linking into the slug drilldown. */
export default function OrgOverviewPage() {
	const { org } = useParams<{ org: string }>();
	const { zones, fetchZones } = useZonesStore();

	useEffect(() => {
		fetchZones();
	}, [fetchZones]);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold tracking-tight text-foreground">
						Zones
					</h1>
					<p className="text-xs text-muted-foreground">
						{zones.length} zone{zones.length !== 1 ? "s" : ""}
					</p>
				</div>
				<Link href="/dashboard/design-spec">
					<Button size="sm" className="h-8 text-xs">
						<Plus className="h-3.5 w-3.5 mr-1.5" />
						Create a Spec
					</Button>
				</Link>
			</div>

			{zones.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Box className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">No zones yet</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Create a spec to get started — it lives inside a zone.
					</p>
				</div>
			) : (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{zones.map((z) => (
						<Link key={z.id} href={z.slug ? zoneHref(org, z.slug) : `/dashboard/zones/${z.id}`}>
							<Card className="transition-colors hover:border-border-strong">
								<CardContent className="flex items-center justify-between p-4">
									<div className="flex items-center gap-3">
										<Box className="h-4 w-4 text-muted-foreground" />
										<div>
											<p className="text-sm font-medium">{z.name}</p>
											<p className="text-xs text-muted-foreground">
												{z.specs?.length ?? 0} spec
												{(z.specs?.length ?? 0) !== 1 ? "s" : ""}
											</p>
										</div>
									</div>
									<ChevronRight className="h-4 w-4 text-muted-foreground" />
								</CardContent>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
