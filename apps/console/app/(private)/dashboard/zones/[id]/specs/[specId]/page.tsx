"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSpec, deleteSpec } from "@/app/server/actions/specs";
import { DuplicateModal } from "@/components/spec-detail/duplicate-modal";
import { useZonesStore } from "@/lib/stores/use-zones-store";
import { usePlan } from "@/components/plan/use-plan";
import { SpecDetailTabs } from "@/components/spec-detail/spec-detail-tabs";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
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

type SpecDetail = Awaited<ReturnType<typeof getSpec>>;

export default function SpecDetailPage() {
	const { id: zoneId, specId } = useParams<{ id: string; specId: string }>();
	const router = useRouter();
	const { removeSpec } = useZonesStore();
	const [detail, setDetail] = useState<SpecDetail | null>(null);

	const refreshDetail = useCallback(() => {
		getSpec(specId).then(setDetail).catch(() => {});
	}, [specId]);

	const plan = usePlan(specId, refreshDetail);
	const [loading, setLoading] = useState(true);
	const [duplicateOpen, setDuplicateOpen] = useState(false);

	useEffect(() => {
		getSpec(specId)
			.then((specData) => {
				setDetail(specData);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [specId]);

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
				<p className="text-muted-foreground text-sm">Spec not found.</p>
			</div>
		);
	}

	const { spec, cloudProvider } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);

	const handlePlan = async (runnerId: string | null) => {
		await plan.generatePlan(runnerId);
	};

	const handleApply = async (runnerId: string | null, rePlan?: boolean) => {
		if (rePlan) {
			await plan.generatePlan(runnerId);
			return;
		}
		if (plan.planJobId) {
			await plan.applyPlan(runnerId);
		} else {
			toast.error("Generate a plan first.");
		}
	};

	const handleApplied = (deployJobId: string) => {
		router.push(`/dashboard/jobs/${deployJobId}`);
	};

	const handleDelete = async () => {
		if (!confirm("Delete this spec and all its components?")) return;
		try {
			await deleteSpec(specId);
			removeSpec(zoneId, specId);
			toast.success("Spec deleted");
			router.push(`/dashboard/zones/${zoneId}`);
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
							<h1 className="text-lg font-semibold">{spec.project_name}</h1>
							<StatusBadge status={spec.status} />
						</div>
						<p className="text-xs text-muted-foreground">
							{meta.shortName} · {spec.region} · {spec.environment_stage}
							{spec.estimated_monthly_cost ? ` · ~$${Math.round(spec.estimated_monthly_cost)}/mo` : ""}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<RunnerSelectPopover
						trigger={
							<Button variant="outline" size="sm" className="h-8 text-xs" disabled={plan.phase === "generating" || plan.phase === "applying"}>
								{plan.phase === "generating" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
								{plan.phase === "generating" ? "Planning..." : "Plan"}
							</Button>
						}
						onConfirm={handlePlan}
						disabled={plan.phase === "generating" || plan.phase === "applying"}
					/>
					<RunnerSelectPopover
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
							<DropdownMenuItem onClick={() => router.push(`/dashboard/design-spec?source=${specId}`)}>
								<Copy className="h-3.5 w-3.5 mr-2" />
								Duplicate &amp; Edit
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
								<Trash2 className="h-3.5 w-3.5 mr-2" />
								Delete Spec
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Tabs */}
			<SpecDetailTabs
				detail={detail}
				specId={specId}
				plan={plan}
				onApplied={handleApplied}
			/>

			<DuplicateModal
				open={duplicateOpen}
				onOpenChange={setDuplicateOpen}
				sourceSpecId={specId}
				sourceSpecName={spec.project_name}
				sourceProvider={providerSlug}
			/>
		</div>
	);
}
