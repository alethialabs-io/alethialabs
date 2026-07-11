"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project card — a clickable tile opening a project (project), with its cloud
// provider icon, region, status, an estimated monthly cost, and a favorite star. Projects
// are the top-level unit under the org.

import { Box, Copy, GitBranch, MoreVertical, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { StatusBadge } from "@repo/ui/status-badge";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { DuplicateProjectDialog } from "@/components/projects/duplicate-project-dialog";
import { orgHref, projectHref } from "@/lib/routing";

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
	const [duplicateOpen, setDuplicateOpen] = useState(false);

	return (
		<div className="group/project relative rounded-lg border bg-card p-3.5 transition-colors hover:border-foreground/20 hover:bg-muted/30">
			{/* Full-card click target (behind content + the star button). */}
			<Link
				href={href}
				aria-label={`Open ${project.project_name}`}
				className="absolute inset-0 z-0 rounded-lg"
			/>

			<div className="pointer-events-none relative z-10">
				<div className="flex items-center gap-2.5">
					<span className="grid size-7 shrink-0 place-items-center rounded-sm border bg-muted/40 text-muted-foreground">
						{provider ? (
							<ProviderIcon
								provider={provider}
								size={15}
								className="opacity-90 grayscale"
							/>
						) : (
							<Box className="h-3.5 w-3.5" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="truncate font-display text-[13.5px] font-semibold text-foreground">
								{project.project_name}
							</span>
							{isFavorite && (
								<Star className="h-3 w-3 shrink-0 fill-current text-muted-foreground" />
							)}
						</div>
						<div className="truncate font-mono text-[10px] text-muted-foreground">
							{project.region || "No region"}
						</div>
					</div>
				</div>

				{repo && (
					<div className="mt-2.5 flex items-center gap-1.5 text-muted-foreground">
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

				<div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
					<StatusBadge status={project.status} />
					{project.estimated_monthly_cost ? (
						<span className="font-mono text-[10.5px] text-muted-foreground">
							${project.estimated_monthly_cost.toFixed(2)}
						</span>
					) : null}
				</div>

				{/* Structured classification (Workstream B) — read-only chips. */}
				<ClassificationChips
					kind="project"
					id={project.id}
					className="mt-2"
				/>
			</div>

			{/* Favorite star — above the link so it stays clickable. */}
			<button
				type="button"
				onClick={onToggleFavorite}
				aria-label={isFavorite ? "Unstar project" : "Star project"}
				className="pointer-events-auto absolute right-9 top-2.5 z-20 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100 data-[on=true]:opacity-100"
				data-on={isFavorite}
			>
				<Star className={`h-3.5 w-3.5 ${isFavorite ? "fill-current" : ""}`} />
			</button>

			{/* Project actions — above the link so it stays clickable. */}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`${project.project_name} actions`}
					className="pointer-events-auto absolute right-2.5 top-2.5 z-20 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/project:opacity-100"
				>
					<MoreVertical className="h-3.5 w-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					<DropdownMenuItem
						disabled={!project.slug}
						onSelect={() => setDuplicateOpen(true)}
					>
						<Copy className="mr-2 h-3.5 w-3.5" />
						Duplicate to another cloud…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<DuplicateProjectDialog
				open={duplicateOpen}
				onOpenChange={setDuplicateOpen}
				sourceProjectId={project.id}
				sourceProjectName={project.project_name}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
