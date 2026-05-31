"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getVineyardById, type VineyardWithVines, type VineWithProvider } from "@/app/server/actions/vineyards";
import { getProvider } from "@/lib/cloud-providers";
import { DataTable } from "@/components/data-table";
import { VineyardEstateMap } from "@/components/vineyards/vineyard-estate-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, Grape, LayoutList, Map, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

const STATUS_STYLES: Record<string, string> = {
	ACTIVE: "text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	DRAFT: "text-muted-foreground border-border bg-muted/50",
	QUEUED: "text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	PROVISIONING: "text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950",
	FAILED: "text-destructive border-destructive/30 bg-destructive/10",
	DESTROYING: "text-orange-600 border-orange-200 bg-orange-50",
	DESTROYED: "text-muted-foreground border-border bg-muted/30",
};

/** Vine table columns for the vineyard detail list view. */
const vineColumns: ColumnDef<VineWithProvider, unknown>[] = [
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
			return (
				<Badge variant="outline" className={`text-[10px] py-0 ${STATUS_STYLES[status] ?? ""}`}>
					{status}
				</Badge>
			);
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

export default function VineyardDetailPage() {
	const { id } = useParams<{ id: string }>();
	const router = useRouter();
	const [vineyard, setVineyard] = useState<VineyardWithVines | null>(null);
	const [loading, setLoading] = useState(true);
	const [view, setView] = useState<"list" | "map">("list");

	useEffect(() => {
		getVineyardById(id).then(({ vineyard: vy }) => {
			setVineyard(vy);
			setLoading(false);
		}).catch(() => setLoading(false));
	}, [id]);

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (!vineyard) {
		return (
			<div className="space-y-4">
				<Link href="/dashboard/vineyards">
					<Button variant="ghost" size="sm" className="text-xs">
						<ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
						Back to Vineyards
					</Button>
				</Link>
				<p className="text-muted-foreground text-sm">Vineyard not found.</p>
			</div>
		);
	}

	const vines = vineyard.vines ?? [];
	const activeCount = vines.filter((v) => v.status === "ACTIVE").length;
	const totalCost = vines.reduce((sum, v) => sum + (v.estimated_monthly_cost ?? 0), 0);

	const handleVineClick = (vine: VineWithProvider) => {
		router.push(`/dashboard/vineyards/${id}/vines/${vine.id}`);
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Link href="/dashboard/vineyards">
						<Button variant="ghost" size="icon" className="h-8 w-8">
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
					<div>
						<h1 className="text-xl font-semibold tracking-tight text-foreground">
							{vineyard.name}
						</h1>
						<p className="text-xs text-muted-foreground">
							{vines.length} vine{vines.length !== 1 ? "s" : ""}
							{activeCount > 0 && ` · ${activeCount} active`}
							{totalCost > 0 && ` · ~$${Math.round(totalCost)}/mo`}
						</p>
					</div>
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
					<Link href="/dashboard/plant">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Plant a Vine
						</Button>
					</Link>
				</div>
			</div>

			{/* Content */}
			{vines.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Grape className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No vines planted
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Plant your first vine in this vineyard to provision infrastructure.
					</p>
					<Link href="/dashboard/plant">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Plant a Vine
						</Button>
					</Link>
				</div>
			) : view === "list" ? (
				<DataTable
					columns={vineColumns}
					data={vines}
					onRowClick={handleVineClick}
					pageSize={20}
				/>
			) : (
				<div className="rounded-xl border border-border shadow-sm overflow-hidden" style={{ height: "calc(100vh - 200px)" }}>
					<VineyardEstateMap vineyard={vineyard as any} />
				</div>
			)}
		</div>
	);
}
