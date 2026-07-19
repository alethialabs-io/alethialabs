"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project card — a clickable tile opening a project's Elench canvas. Infra-forward: the
// cloud provider mark, region + stage, the default env's services/add-on rollup, deploy state and
// estimated cost, with the git repo as secondary context. Projects are the top-level unit under
// the org.

import { formatDistanceToNow } from "date-fns";
import { Box, GitBranch } from "lucide-react";
import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ProjectActionsMenu } from "@/components/overview/project-actions-menu";
import { orgHref, projectHref } from "@/lib/routing";

/** Pluralizes a count into an "N thing(s)" / "No things" label. */
function countLabel(n: number, singular: string): string {
	if (n === 0) return `No ${singular}s`;
	return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** A single project tile. */
export function ProjectCard({
	project,
	orgSlug,
	isFavorite,
	onToggleFavorite,
}: {
	project: ProjectListItem;
	orgSlug: string;
	isFavorite: boolean;
	onToggleFavorite: () => void;
}) {
	const href = project.slug
		? projectHref(orgSlug, project.slug)
		: orgHref(orgSlug);
	const provider = project.cloud_provider;
	const repo = project.repositories[0];
	const deployed = project.last_deployed_at
		? `Deployed ${formatDistanceToNow(new Date(project.last_deployed_at), { addSuffix: true })}`
		: "Never deployed";

	return (
		<div className="group/project relative rounded-lg border bg-card p-3.5 transition-colors hover:border-foreground/20 hover:bg-muted/30">
			{/* Full-card click target (behind content + the actions menu). */}
			<Link
				href={href}
				aria-label={`Open ${project.project_name}`}
				className="absolute inset-0 z-0 rounded-lg"
			/>

			<div className="pointer-events-none relative z-10">
				<div className="flex items-center gap-2.5">
					<span className="grid size-7 shrink-0 place-items-center rounded-sm border bg-muted/40 text-muted-foreground">
						{provider ? (
							<ProviderIcon provider={provider} size={15} mono={false} />
						) : (
							<Box className="h-3.5 w-3.5" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate font-display text-[13.5px] font-semibold text-foreground">
							{project.project_name}
						</div>
						<div className="truncate font-mono text-[10px] text-muted-foreground">
							{project.region || "No region"}
							{project.environment_stage ? ` · ${project.environment_stage}` : ""}
						</div>
					</div>
				</div>

				{/* Primary meta — the default env's configured services + add-ons. */}
				<div className="mt-3 truncate font-mono text-[11px] text-muted-foreground">
					{countLabel(project.services_count, "service")}
					<span className="text-muted-foreground/50"> · </span>
					{countLabel(project.addons_count, "add-on")}
				</div>

				<div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
					<span className="truncate text-[11px] text-muted-foreground">
						{deployed}
					</span>
					{project.estimated_monthly_cost ? (
						<span className="shrink-0 font-mono text-[10.5px] text-foreground">
							${project.estimated_monthly_cost.toFixed(2)}/mo
						</span>
					) : null}
				</div>

				{repo && (
					<div className="mt-2 flex items-center gap-1.5 text-muted-foreground">
						<GitBranch className="h-3 w-3 shrink-0" />
						<span className="truncate font-mono text-[10px]">
							{repo.label}
							{project.repositories.length > 1 && (
								<span className="text-muted-foreground/60">
									{" "}
									+{project.repositories.length - 1}
								</span>
							)}
						</span>
					</div>
				)}
			</div>

			{/* Project actions — above the link so it stays clickable. */}
			<ProjectActionsMenu
				project={project}
				orgSlug={orgSlug}
				isFavorite={isFavorite}
				onToggleFavorite={onToggleFavorite}
				triggerClassName="pointer-events-auto absolute right-2.5 top-2.5 z-20 opacity-0 focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/project:opacity-100"
			/>
		</div>
	);
}
