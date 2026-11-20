"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project row — the table-view counterpart to `ProjectCard`. One project per row:
// provider glyph + name, cloud, region, status, environment count, add-ons, estimated cost,
// last-deploy time, and the shared actions menu. The columns are `PROJECT_TABLE_COLUMNS`
// (projects-skeleton.tsx), in that order.

import { Box } from "lucide-react";
import Link from "next/link";
import { formatMonthlyRate, formatRelative } from "@repo/format";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { TableCell, TableRow } from "@repo/ui/table";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ClockSlot } from "@/components/overview/clock-slot";
import { ProjectActionsMenu } from "@/components/overview/project-actions-menu";
import { providerLabel } from "@/components/overview/project-cloud";
import { orgHref, projectHref } from "@/lib/routing";

/** A single project as a table row. */
export function ProjectRow({
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
	const href = project.slug
		? projectHref(orgSlug, project.slug)
		: orgHref(orgSlug);
	const provider = project.cloud_provider;
	const deployedAt = project.last_deployed_at;

	return (
		<TableRow className="group/row">
			<TableCell>
				<Link
					href={href}
					className="flex items-center gap-2.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					{provider ? (
						<ProviderIcon
							provider={provider}
							size={18}
							mono={!providerConnected}
							className="shrink-0"
						/>
					) : (
						<Box aria-hidden className="size-4 shrink-0 text-muted-foreground" />
					)}
					<span className="truncate font-display text-ui-md font-medium text-foreground group-hover/row:underline">
						{project.project_name}
					</span>
				</Link>
			</TableCell>
			<TableCell className="text-muted-foreground">
				{provider ? providerLabel(provider) : "—"}
				{cloudUnavailable ? (
					<span data-slot="cloud-unavailable" className="block max-w-56 whitespace-normal text-ui-2xs">
						{cloudUnavailable}
					</span>
				) : null}
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.region || "—"}
			</TableCell>
			<TableCell>
				<StatusBadge status={project.status} />
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.environments_count}
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.addons_count}
			</TableCell>
			<TableCell className="text-right font-mono text-ui-xs text-muted-foreground">
				{project.estimated_monthly_cost
					? formatMonthlyRate(project.estimated_monthly_cost)
					: "—"}
			</TableCell>
			<TableCell className="text-right font-mono text-ui-xs text-muted-foreground">
				{deployedAt ? (
					<ClockSlot
						sizer="less than a minute ago"
						className="justify-items-end"
						render={() => formatRelative(deployedAt)}
					/>
				) : (
					"Never"
				)}
			</TableCell>
			<TableCell className="text-right">
				<ProjectActionsMenu
					project={project}
					orgSlug={orgSlug}
					isFavorite={isFavorite}
					onToggleFavorite={onToggleFavorite}
					triggerClassName="ml-auto opacity-0 focus-visible:opacity-100 data-[popup-open]:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100"
				/>
			</TableCell>
		</TableRow>
	);
}
