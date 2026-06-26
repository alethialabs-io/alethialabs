"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The zone-detail body, parameterized by id so BOTH the legacy UUID route
// (`/dashboard/zones/[id]`) and the C2 slug route (`/{org}/{zone}`) render it.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
	getZoneById,
	type ZoneWithSpecs,
	type SpecWithProvider,
} from "@/app/server/actions/zones";
import { getProvider } from "@/lib/cloud-providers";
import { DataTable } from "@/components/data-table";
import { ZoneEstateMap } from "@/components/zones/zone-estate-map";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { specHref } from "@/lib/routing";
import type { ColumnDef } from "@tanstack/react-table";
import { Box, LayoutList, Map, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { StatusBadge } from "@repo/ui/status-badge";

/** Spec table columns for the zone detail list view. */
const specColumns: ColumnDef<SpecWithProvider, unknown>[] = [
	{
		accessorKey: "project_name",
		header: "Project",
		cell: ({ row }) => (
			<span className="text-sm font-medium font-mono">{row.getValue("project_name")}</span>
		),
	},
	{
		accessorKey: "cloud_provider",
		header: "Provider",
		cell: ({ row }) => {
			const provider = row.getValue("cloud_provider") as string | null;
			if (!provider) return <span className="text-xs text-muted-foreground">—</span>;
			const meta = getProvider(provider);
			return (
				<div className="flex items-center gap-1.5">
					<Image src={meta.icon} alt={meta.shortName} width={16} height={16} />
					<span className="text-xs">{meta.shortName}</span>
				</div>
			);
		},
	},
	{
		accessorKey: "region",
		header: "Region",
		cell: ({ row }) => (
			<span className="text-xs font-mono text-muted-foreground">{row.getValue("region")}</span>
		),
	},
	{
		accessorKey: "environment_stage",
		header: "Env",
		cell: ({ row }) => (
			<Badge variant="outline" className="text-[10px] py-0">
				{(row.getValue("environment_stage") as string)?.slice(0, 4)}
			</Badge>
		),
	},
	{
		accessorKey: "status",
		header: "Status",
		cell: ({ row }) => {
			const status = row.getValue("status") as string;
			return <StatusBadge status={status} />;
		},
	},
	{
		accessorKey: "estimated_monthly_cost",
		header: "Cost",
		cell: ({ row }) => {
			const cost = row.getValue("estimated_monthly_cost") as number | null;
			return (
				<span className="text-xs font-mono text-muted-foreground">
					{cost ? `$${Math.round(cost)}` : "—"}
				</span>
			);
		},
	},
	{
		accessorKey: "updated_at",
		header: "Updated",
		cell: ({ row }) => {
			const date = row.getValue("updated_at") as string;
			return (
				<span className="text-xs text-muted-foreground">
					{formatDistanceToNow(new Date(date), { addSuffix: true })}
				</span>
			);
		},
	},
];

export function ZoneDetailView({ zoneId }: { zoneId: string }) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const [zone, setZone] = useState<ZoneWithSpecs | null>(null);
	const [loading, setLoading] = useState(true);
	const [view, setView] = useState<"list" | "map">("list");

	useEffect(() => {
		getZoneById(zoneId).then(({ zone: z }) => {
			setZone(z);
			setLoading(false);
		}).catch(() => setLoading(false));
	}, [zoneId]);

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (!zone) {
		return (
			<div className="space-y-4">
				<p className="text-muted-foreground text-sm">Zone not found.</p>
			</div>
		);
	}

	const specs = zone.specs ?? [];
	const activeCount = specs.filter((v) => v.status === "ACTIVE").length;
	const totalCost = specs.reduce((sum, v) => sum + (v.estimated_monthly_cost ?? 0), 0);

	const handleSpecClick = (spec: SpecWithProvider) => {
		// Prefer the slug route; fall back to the UUID route if slugs aren't loaded.
		router.push(
			zone.slug && spec.slug
				? specHref(orgSlug, zone.slug, spec.slug)
				: `/dashboard/zones/${zoneId}/specs/${spec.id}`,
		);
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold tracking-tight text-foreground">
						{zone.name}
					</h1>
					<p className="text-xs text-muted-foreground">
						{specs.length} spec{specs.length !== 1 ? "s" : ""}
						{activeCount > 0 && ` · ${activeCount} active`}
						{totalCost > 0 && ` · ~$${Math.round(totalCost)}/mo`}
					</p>
				</div>

				<div className="flex items-center gap-2">
					<div className="flex items-center border border-border/50 rounded-md">
						<Button
							variant={view === "list" ? "secondary" : "ghost"}
							size="sm"
							className="h-8 text-xs rounded-r-none"
							onClick={() => setView("list")}
						>
							<LayoutList className="h-3.5 w-3.5 mr-1.5" />
							List
						</Button>
						<Button
							variant={view === "map" ? "secondary" : "ghost"}
							size="sm"
							className="h-8 text-xs rounded-l-none"
							onClick={() => setView("map")}
						>
							<Map className="h-3.5 w-3.5 mr-1.5" />
							Map
						</Button>
					</div>
					<Link href="/dashboard/design-spec">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Create a Spec
						</Button>
					</Link>
				</div>
			</div>

			{/* Content */}
			{specs.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Box className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No specs yet
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Create your first spec in this zone to provision infrastructure.
					</p>
					<Link href="/dashboard/design-spec">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Create a Spec
						</Button>
					</Link>
				</div>
			) : view === "list" ? (
				<DataTable
					columns={specColumns}
					data={specs}
					onRowClick={handleSpecClick}
					pageSize={20}
				/>
			) : (
				<div className="rounded-xl border border-border shadow-sm overflow-hidden" style={{ height: "calc(100vh - 200px)" }}>
					<ZoneEstateMap zone={zone} />
				</div>
			)}
		</div>
	);
}
