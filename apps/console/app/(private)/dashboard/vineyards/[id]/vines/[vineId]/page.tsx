"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getVine, deleteVine } from "@/app/server/actions/vines";
import { DuplicateModal } from "@/components/vine-detail/duplicate-modal";
import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";
import { usePlan } from "@/components/plan/use-plan";
import { VineDetailTabs } from "@/components/vine-detail/vine-detail-tabs";
import { TendrilSelectPopover } from "@/components/tendrils/tendril-select-popover";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
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
	Copy,
	FileText,
	Loader2,
	MoreHorizontal,
	Rocket,
	Trash2,
} from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { StatusBadge } from "@/components/ui/status-badge";

import { toast } from "sonner";

type VineDetail = Awaited<ReturnType<typeof getVine>>;

export default function VineDetailPage() {
	const { id: vineyardId, vineId } = useParams<{ id: string; vineId: string }>();
	const router = useRouter();
	const { removeVine } = useVineyardsStore();
	const [detail, setDetail] = useState<VineDetail | null>(null);

	const refreshDetail = useCallback(() => {
		getVine(vineId).then(setDetail).catch(() => {});
	}, [vineId]);

	const plan = usePlan(vineId, refreshDetail);
	const [loading, setLoading] = useState(true);
	const [duplicateOpen, setDuplicateOpen] = useState(false);

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
				<p className="text-muted-foreground text-sm">Vine not found.</p>
			</div>
		);
	}

	const { vine, cloudProvider } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);

	const handlePlan = async (workerId: string | null) => {
		await plan.generatePlan(workerId);
	};

	const handleApply = async (workerId: string | null, rePlan?: boolean) => {
		if (rePlan) {
			await plan.generatePlan(workerId);
			return;
		}
		if (plan.planJobId) {
			await plan.applyPlan(workerId);
		} else {
			toast.error("Generate a plan first.");
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
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<ProviderIcon provider={providerSlug} size={24} />
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-lg font-semibold">{vine.project_name}</h1>
							<StatusBadge status={vine.status} />
						</div>
						<p className="text-xs text-muted-foreground">
							{meta.shortName} · {vine.region} · {vine.environment_stage}
							{vine.estimated_monthly_cost ? ` · ~$${Math.round(vine.estimated_monthly_cost)}/mo` : ""}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<TendrilSelectPopover
						trigger={
							<Button variant="outline" size="sm" className="h-8 text-xs" disabled={plan.phase === "generating" || plan.phase === "applying"}>
								{plan.phase === "generating" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
								{plan.phase === "generating" ? "Planning..." : "Plan"}
							</Button>
						}
						onConfirm={handlePlan}
						disabled={plan.phase === "generating" || plan.phase === "applying"}
					/>
					<TendrilSelectPopover
						trigger={
							<Button size="sm" className="h-8 text-xs" disabled={plan.phase !== "ready" && plan.phase !== "failed"}>
								{plan.phase === "applying" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5 mr-1.5" />}
								{plan.phase === "applying" ? "Applying..." : "Apply"}
							</Button>
						}
						onConfirm={handleApply}
						disabled={plan.phase !== "ready" && plan.phase !== "failed"}
						showRePlan={plan.phase === "ready" || plan.phase === "failed"}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="h-8 w-8">
								<MoreHorizontal className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => setDuplicateOpen(true)}>
								<ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
								Quick Duplicate
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => router.push(`/dashboard/plant?source=${vineId}`)}>
								<Copy className="h-3.5 w-3.5 mr-2" />
								Duplicate &amp; Edit
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

			<DuplicateModal
				open={duplicateOpen}
				onOpenChange={setDuplicateOpen}
				sourceVineId={vineId}
				sourceVineName={vine.project_name}
				sourceProvider={providerSlug}
			/>
		</div>
	);
}
