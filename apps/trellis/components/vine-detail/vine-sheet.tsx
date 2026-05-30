"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getVine } from "@/app/server/actions/vines";
import { LogViewer } from "@/components/clusters/log-viewer";
import { PlanTab } from "@/components/plan/plan-tab";
import { JobsTab } from "@/components/plan/jobs-tab";
import { usePlan } from "@/components/plan/use-plan";
import { OverviewTab } from "./overview-tab";
import { CliGuide } from "./cli-guide";
import { DuplicateVineDialog } from "./duplicate-vine-dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PublicVinesRow } from "@/lib/validations/db.schemas";

interface VineSheetProps {
	vines: PublicVinesRow[];
}

const STATUS_STYLES: Record<string, string> = {
	DRAFT: "border-muted-foreground/50 text-muted-foreground",
	QUEUED: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400",
	PROVISIONING:
		"border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	ACTIVE: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	FAILED: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400",
	DESTROYING:
		"border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400",
	DESTROYED: "border-muted-foreground/50 text-muted-foreground",
};

type VineDetail = Awaited<ReturnType<typeof getVine>>;

export function VineSheet({ vines }: VineSheetProps) {
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();

	const [logViewerJobId, setLogViewerJobId] = useState<string | null>(null);
	const [logViewerOpen, setLogViewerOpen] = useState(false);
	const [detail, setDetail] = useState<VineDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [activeTab, setActiveTab] = useState("overview");

	const vineId = searchParams.get("config_id") || searchParams.get("vine_id");
	const open = !!vineId;
	const vine = vines.find((v) => v.id === vineId);
	const plan = usePlan(vineId);

	useEffect(() => {
		if (!vineId) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		setDetailLoading(true);
		getVine(vineId)
			.then((d) => {
				if (!cancelled) setDetail(d);
			})
			.catch(() => {})
			.finally(() => {
				if (!cancelled) setDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [vineId]);

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			const params = new URLSearchParams(searchParams.toString());
			params.delete("config_id");
			params.delete("vine_id");
			router.replace(`${pathname}?${params.toString()}`, {
				scroll: false,
			});
			setLogViewerJobId(null);
			setActiveTab("overview");
		}
	};

	const handleApplied = (deployJobId: string) => {
		setLogViewerJobId(deployJobId);
		setLogViewerOpen(true);
		setActiveTab("jobs");
	};

	const handleSelectJob = (jobId: string) => {
		setLogViewerJobId(jobId);
		setLogViewerOpen(true);
	};

	return (
		<>
			<Sheet open={open} onOpenChange={handleOpenChange}>
				<SheetContent className="w-[95vw] sm:max-w-4xl overflow-hidden p-0 flex flex-col">
					<SheetHeader className="px-6 py-4 border-b border-border/40">
						<div className="flex items-center gap-2">
							<SheetTitle className="text-base">
								{vine?.project_name ?? "Vine Details"}
							</SheetTitle>
							{vine && (
								<Badge
									variant="outline"
									className={`text-[10px] ${STATUS_STYLES[vine.status || "DRAFT"] || ""}`}
								>
									{vine.status || "DRAFT"}
								</Badge>
							)}
						</div>
						{detail && vine && (
							<DuplicateVineDialog
								vineId={vine.id}
								vineName={vine.project_name}
								sourceProvider={detail.cloudProvider}
							/>
						)}
						<SheetDescription className="text-xs">
							Review configuration, generate infrastructure
							plans, and track provisioning jobs.
						</SheetDescription>
					</SheetHeader>

					<Tabs
						value={activeTab}
						onValueChange={setActiveTab}
						className="flex-1 flex flex-col overflow-hidden"
					>
						<div className="px-6">
							<TabsList variant="line">
								<TabsTrigger value="overview">
									Overview
								</TabsTrigger>
								<TabsTrigger value="plan">
									Plan + Cost
								</TabsTrigger>
								<TabsTrigger value="jobs">Jobs</TabsTrigger>
								<TabsTrigger value="grape">
									Grape CLI
								</TabsTrigger>
							</TabsList>
						</div>

						<ScrollArea className="h-[85vh]">
							<div className="px-6 py-5">
								<TabsContent
									value="overview"
									className="mt-0"
								>
									{detailLoading ? (
										<div className="space-y-4">
											<Skeleton className="h-48 w-full rounded-lg" />
											<Skeleton className="h-32 w-full rounded-lg" />
										</div>
									) : detail ? (
										<OverviewTab detail={detail} />
									) : (
										<p className="text-sm text-muted-foreground text-center py-10">
											Vine not found.
										</p>
									)}
								</TabsContent>

								<TabsContent value="plan" className="mt-0">
									<PlanTab
										plan={plan}
										onApplied={handleApplied}
									/>
								</TabsContent>

								<TabsContent value="jobs" className="mt-0">
									{vineId && (
										<JobsTab
											vineId={vineId}
											onSelectJob={handleSelectJob}
										/>
									)}
								</TabsContent>

								<TabsContent value="grape" className="mt-0">
									<CliGuide
										projectName={
											vine?.project_name || "my-project"
										}
									/>
								</TabsContent>
							</div>
						</ScrollArea>
					</Tabs>
				</SheetContent>
			</Sheet>

			<LogViewer
				jobId={logViewerJobId}
				clusterName={vine?.project_name || "Provisioning"}
				open={logViewerOpen}
				onOpenChange={setLogViewerOpen}
			/>
		</>
	);
}
