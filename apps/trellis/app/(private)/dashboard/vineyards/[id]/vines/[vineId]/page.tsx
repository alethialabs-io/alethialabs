"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getVine, deleteVine } from "@/app/server/actions/vines";
import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";
import { usePlan } from "@/components/plan/use-plan";
import { VineDetailTabs } from "@/components/vine-detail/vine-detail-tabs";
import { WorkerSelectPopover } from "@/components/workers/worker-select-popover";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	ArrowRightLeft,
	FileText,
	Loader2,
	MoreHorizontal,
	Rocket,
	Trash2,
} from "lucide-react";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import Image from "next/image";

import { toast } from "sonner";

type VineDetail = Awaited<ReturnType<typeof getVine>>;

const VINE_STATUS_STYLES: Record<string, string> = {
	ACTIVE: "text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	DRAFT: "text-muted-foreground border-border bg-muted/50",
	QUEUED: "text-blue-600 border-blue-200 bg-blue-50",
	PROVISIONING: "text-amber-600 border-amber-200 bg-amber-50",
	FAILED: "text-destructive border-destructive/30 bg-destructive/10",
	DESTROYING: "text-orange-600 border-orange-200 bg-orange-50",
	DESTROYED: "text-muted-foreground border-border bg-muted/30",
};

export default function VineDetailPage() {
	const { id: vineyardId, vineId } = useParams<{ id: string; vineId: string }>();
	const router = useRouter();
	const { vineyards, removeVine } = useVineyardsStore();
	const plan = usePlan(vineId);
	const [detail, setDetail] = useState<VineDetail | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		getVine(vineId)
			.then((vineData) => {
				setDetail(vineData);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [vineId]);

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (!detail) {
		return (
			<div className="space-y-4">
				<BreadcrumbNav items={[
					{ label: "Vineyards", href: "/dashboard/vineyards" },
					{ label: "Vineyard", href: `/dashboard/vineyards/${vineyardId}` },
					{ label: "Not found" },
				]} />
				<p className="text-muted-foreground text-sm">Vine not found.</p>
			</div>
		);
	}

	const vineyardName = vineyards.find((vy) => vy.id === vineyardId)?.name ?? "Vineyard";

	const { vine, cloudProvider } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);

	const handlePlan = async (workerId: string | null) => {
		await plan.generatePlan(workerId);
	};

	const handleDeploy = async (workerId: string | null) => {
		if (plan.planJobId) {
			await plan.applyPlan(workerId);
		} else {
			toast.error("Generate a plan first before deploying.");
		}
	};

	const handleApplied = (deployJobId: string) => {
		router.push(`/dashboard/jobs/${deployJobId}`);
	};

	const handleDelete = async () => {
		if (!confirm("Delete this vine and all its components?")) return;
		try {
			await deleteVine(vineId);
			removeVine(vineyardId, vineId);
			toast.success("Vine deleted");
			router.push(`/dashboard/vineyards/${vineyardId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<BreadcrumbNav items={[
				{ label: "Vineyards", href: "/dashboard/vineyards" },
				{ label: vineyardName, href: `/dashboard/vineyards/${vineyardId}` },
				{ label: vine.project_name },
			]} />

			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Image src={meta.icon} alt={meta.shortName} width={24} height={24} />
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-lg font-semibold">{vine.project_name}</h1>
							<Badge variant="outline" className={`text-[10px] ${VINE_STATUS_STYLES[vine.status] ?? ""}`}>
								{vine.status}
							</Badge>
						</div>
						<p className="text-xs text-muted-foreground">
							{meta.shortName} · {vine.region} · {vine.environment_stage}
							{vine.estimated_monthly_cost ? ` · ~$${Math.round(vine.estimated_monthly_cost)}/mo` : ""}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<WorkerSelectPopover
						trigger={
							<Button variant="outline" size="sm" className="h-8 text-xs" disabled={plan.phase === "generating" || plan.phase === "applying"}>
								{plan.phase === "generating" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
								{plan.phase === "generating" ? "Planning..." : "Plan"}
							</Button>
						}
						onConfirm={handlePlan}
						disabled={plan.phase === "generating" || plan.phase === "applying"}
					/>
					<WorkerSelectPopover
						trigger={
							<Button size="sm" className="h-8 text-xs" disabled={plan.phase !== "ready"}>
								{plan.phase === "applying" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5 mr-1.5" />}
								{plan.phase === "applying" ? "Deploying..." : "Deploy"}
							</Button>
						}
						onConfirm={handleDeploy}
						disabled={plan.phase !== "ready"}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="h-8 w-8">
								<MoreHorizontal className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => router.push(`/dashboard/plant`)}>
								<ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
								Duplicate for Provider
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
								<Trash2 className="h-3.5 w-3.5 mr-2" />
								Delete Vine
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Tabs */}
			<VineDetailTabs
				detail={detail as any}
				vineId={vineId}
				plan={plan}
				onApplied={handleApplied}
			/>
		</div>
	);
}
