"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project card — a clickable tile opening a project (project), with its cloud
// provider icon, region, status, an estimated monthly cost, and a favorite star. Projects
// are the top-level unit under the org.

import { Box, Star } from "lucide-react";
import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import type { ProjectWithProvider } from "@/app/server/actions/projects";
import { orgHref, projectHref } from "@/lib/routing";

/** A single project (project) tile. */
export function ProjectCard({
	project,
	orgSlug,
	isFavorite,
	onToggleFavorite,
}: {
	project: ProjectWithProvider;
	orgSlug: string;
	isFavorite: boolean;
	onToggleFavorite: () => void;
}) {
	const href = project.slug
		? projectHref(orgSlug, project.slug)
		: orgHref(orgSlug);
	const provider = project.cloud_provider;

	return (
		<div className="group/project relative rounded-lg border bg-card p-3.5 shadow-sm transition-all hover:-translate-y-px hover:border-foreground/20 hover:shadow-md">
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

				<div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
					<StatusBadge status={project.status} />
					{project.estimated_monthly_cost ? (
						<span className="font-mono text-[10.5px] text-muted-foreground">
							${project.estimated_monthly_cost.toFixed(2)}
						</span>
					) : null}
				</div>
			</div>

			{/* Favorite star — above the link so it stays clickable. */}
			<button
				type="button"
				onClick={onToggleFavorite}
				aria-label={isFavorite ? "Unstar project" : "Star project"}
				className="pointer-events-auto absolute right-2.5 top-2.5 z-20 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100 data-[on=true]:opacity-100"
				data-on={isFavorite}
			>
				<Star className={`h-3.5 w-3.5 ${isFavorite ? "fill-current" : ""}`} />
			</button>
		</div>
	);
}
