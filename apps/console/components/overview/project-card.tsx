"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project card — a tile that opens a project's Architecture page. The cloud's mark, the
// region and stage, the default environment's services and add-ons, its status as the console last
// observed it, the last deploy and the estimated cost, with the git repository as secondary
// context.

import { Box, GitBranch } from "lucide-react";
import Link from "next/link";
import { formatMonthlyRate, formatRelative } from "@repo/format";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ClockSlot } from "@/components/overview/clock-slot";
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
	providerConnected,
	cloudUnavailable,
}: {
	project: ProjectListItem;
	orgSlug: string;
	isFavorite: boolean;
	/** Stars or unstars the project. Absent while nobody is signed in to star it for. */
	onToggleFavorite?: () => void;
	/** The project's cloud has a connected account: its mark is drawn in colour. */
	providerConnected: boolean;
	/** Why this project cannot be planned or deployed here (`cloudNotOfferedReason`), or `null`. */
	cloudUnavailable: string | null;
}) {
	const href = project.slug ? projectHref(orgSlug, project.slug) : orgHref(orgSlug);
	const provider = project.cloud_provider;
	const repo = project.repositories[0];
	const deployedAt = project.last_deployed_at;

	return (
		<div className="group/project relative rounded-lg border bg-card p-3.5 transition-colors focus-within:border-foreground/20 hover:border-foreground/20 hover:bg-muted/30">
			{/* The whole card is the link (behind the content and the actions menu). */}
			<Link
				href={href}
				aria-label={`Open ${project.project_name}`}
				className="absolute inset-0 z-0 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
			/>

			<div className="pointer-events-none relative z-10">
				<div className="flex items-center gap-2.5 pr-7">
					{provider ? (
						<ProviderIcon provider={provider} size={28} mono={!providerConnected} className="shrink-0" />
					) : (
						<Box aria-hidden className="size-6 shrink-0 text-muted-foreground" />
					)}
					<div className="min-w-0 flex-1">
						<div className="truncate font-display text-ui-md font-semibold text-foreground">
							{project.project_name}
						</div>
						<div className="truncate font-mono text-ui-2xs text-muted-foreground">
							{project.region || "No region"}
							{project.environment_stage ? ` · ${project.environment_stage}` : ""}
						</div>
					</div>
				</div>

				{/* The default environment's configured services and add-ons, and what it costs. */}
				<div className="mt-3 flex items-center justify-between gap-2">
					<span className="truncate font-mono text-ui-xs text-muted-foreground">
						{countLabel(project.services_count, "service")}
						<span className="text-text-tertiary"> · </span>
						{countLabel(project.addons_count, "add-on")}
					</span>
					{project.estimated_monthly_cost ? (
						<span className="shrink-0 font-mono text-ui-2xs text-foreground">
							{formatMonthlyRate(project.estimated_monthly_cost)}
						</span>
					) : null}
				</div>

				{/* The default environment's status as the console last observed it, and the last deploy. */}
				<div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
					<StatusBadge status={project.status} />
					{deployedAt ? (
						<ClockSlot
							sizer="Deployed less than a minute ago"
							className="justify-items-end truncate text-ui-xs text-muted-foreground"
							render={() => `Deployed ${formatRelative(deployedAt)}`}
						/>
					) : (
						<span className="truncate text-ui-xs text-muted-foreground">Never deployed</span>
					)}
				</div>

				{cloudUnavailable ? (
					<p data-slot="cloud-unavailable" className="mt-2 text-ui-2xs text-muted-foreground">
						{cloudUnavailable}
					</p>
				) : null}

				{repo && (
					<div className="mt-2 flex items-center gap-1.5 text-muted-foreground">
						<GitBranch aria-hidden className="h-3 w-3 shrink-0" />
						<span className="truncate font-mono text-ui-2xs">
							{repo.label}
							{project.repositories.length > 1 && (
								<span className="text-text-tertiary"> +{project.repositories.length - 1}</span>
							)}
						</span>
					</div>
				)}
			</div>

			{/* Above the link so it stays clickable. Visible on hover, on keyboard focus, while its menu
			    is open, and always where there is no hover to reveal it (a touch screen). */}
			<ProjectActionsMenu
				project={project}
				orgSlug={orgSlug}
				isFavorite={isFavorite}
				onToggleFavorite={onToggleFavorite}
				triggerClassName="pointer-events-auto absolute right-2.5 top-2.5 z-20 opacity-0 focus-visible:opacity-100 data-[popup-open]:opacity-100 group-hover/project:opacity-100 [@media(hover:none)]:opacity-100"
			/>
		</div>
	);
}
