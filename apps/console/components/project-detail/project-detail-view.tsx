"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project-detail body, parameterized by project id so the C2 slug route
// (`/{org}/{project}[/{env}]`) renders it. The optional `envName` is the environment
// focused by the URL (drives the header status + the Environments tab). A project IS a
// project.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getProject, deleteProject } from "@/app/server/actions/projects";
import { DuplicateModal } from "@/components/project-detail/duplicate-modal";
import { useProjectsStore } from "@/lib/stores/use-projects-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref } from "@/lib/routing";
import { usePlan } from "@/components/plan/use-plan";
import { ProjectDetailTabs } from "@/components/project-detail/project-detail-tabs";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
	ArrowRightLeft,
	Copy,
	FileText,
	Loader2,
	MoreHorizontal,
	Rocket,
	Trash2,
} from "lucide-react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";

import { toast } from "sonner";

type ProjectData = Awaited<ReturnType<typeof getProject>>;

interface ProjectDetailViewProps {
	projectId: string;
	/** The environment focused by the URL (`/{org}/{project}/{env}`), if any. */
	envName?: string;
}

export function ProjectDetailView({ projectId, envName }: ProjectDetailViewProps) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { removeProject } = useProjectsStore();
	const [detail, setDetail] = useState<ProjectData | null>(null);

	const refreshDetail = useCallback(() => {
		getProject(projectId).then(setDetail).catch(() => {});
	}, [projectId]);

	const plan = usePlan(projectId, refreshDetail);
	const [loading, setLoading] = useState(true);
	const [duplicateOpen, setDuplicateOpen] = useState(false);

	useEffect(() => {
		getProject(projectId)
			.then((projectData) => {
				setDetail(projectData);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [projectId]);

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
				<p className="text-muted-foreground text-sm">Project not found.</p>
			</div>
		);
	}

	const { project, cloudProvider } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);

	// The environment the URL focuses (else the project's default), for the header.
	const activeEnv =
		detail.environments?.find((e) => e.name === envName) ??
		detail.environments?.find((e) => e.is_default) ??
		null;
	const headEnvName = activeEnv?.name ?? project.environment_stage;
	const headStatus = activeEnv?.status ?? project.status;

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
		if (!confirm("Delete this project and all its components?")) return;
		try {
			await deleteProject(projectId);
			removeProject(projectId);
			toast.success("Project deleted");
			router.push(orgHref(orgSlug));
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
							<h1 className="text-lg font-semibold">{project.project_name}</h1>
							<StatusBadge status={headStatus} />
						</div>
						<p className="text-xs text-muted-foreground">
							{meta.shortName} · {project.region} · {headEnvName}
							{project.estimated_monthly_cost ? ` · ~$${Math.round(project.estimated_monthly_cost)}/mo` : ""}
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
							<DropdownMenuItem onClick={() => router.push(`/dashboard/design-project?source=${projectId}`)}>
								<Copy className="h-3.5 w-3.5 mr-2" />
								Duplicate &amp; Edit
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
								<Trash2 className="h-3.5 w-3.5 mr-2" />
								Delete Project
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Tabs */}
			<ProjectDetailTabs
				detail={detail}
				projectId={projectId}
				plan={plan}
				onApplied={handleApplied}
			/>

			<DuplicateModal
				open={duplicateOpen}
				onOpenChange={setDuplicateOpen}
				sourceProjectId={projectId}
				sourceProjectName={project.project_name}
				sourceProvider={providerSlug}
			/>
		</div>
	);
}
