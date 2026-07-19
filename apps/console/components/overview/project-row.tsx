"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project row — the table-view counterpart to `ProjectCard`. One project per row:
// provider glyph + name, cloud, region, status, environment count, add-ons, estimated cost,
// last-deploy time, and the shared actions menu.

import { formatDistanceToNow } from "date-fns";
import { Box } from "lucide-react";
import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { TableCell, TableRow } from "@repo/ui/table";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ProjectActionsMenu } from "@/components/overview/project-actions-menu";
import { orgHref, projectHref } from "@/lib/routing";

/** Human label for a cloud provider slug (falls back to uppercase). */
const PROVIDER_LABEL: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	alibaba: "Alibaba",
	digitalocean: "DigitalOcean",
	hetzner: "Hetzner",
	civo: "Civo",
};

/** A single project as a table row. */
export function ProjectRow({
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

	return (
		<TableRow className="group/row">
			<TableCell>
				<Link href={href} className="flex items-center gap-2.5">
					<span className="grid size-6 shrink-0 place-items-center rounded-sm border bg-muted/40 text-muted-foreground">
						{provider ? (
							<ProviderIcon provider={provider} size={13} mono={false} />
						) : (
							<Box className="h-3 w-3" />
						)}
					</span>
					<span className="truncate font-display text-[13px] font-medium text-foreground group-hover/row:underline">
						{project.project_name}
					</span>
				</Link>
			</TableCell>
			<TableCell className="text-muted-foreground">
				{provider ? (PROVIDER_LABEL[provider] ?? provider.toUpperCase()) : "—"}
			</TableCell>
			<TableCell className="font-mono text-[11px] text-muted-foreground">
				{project.region || "—"}
			</TableCell>
			<TableCell>
				<StatusBadge status={project.status} />
			</TableCell>
			<TableCell className="font-mono text-[11px] text-muted-foreground">
				{project.environments_count}
			</TableCell>
			<TableCell className="font-mono text-[11px] text-muted-foreground">
				{project.addons_count}
			</TableCell>
			<TableCell className="text-right font-mono text-[11px] text-muted-foreground">
				{project.estimated_monthly_cost
					? `$${project.estimated_monthly_cost.toFixed(2)}`
					: "—"}
			</TableCell>
			<TableCell className="text-right font-mono text-[11px] text-muted-foreground">
				{project.last_deployed_at
					? formatDistanceToNow(new Date(project.last_deployed_at), {
							addSuffix: true,
						})
					: "Never"}
			</TableCell>
			<TableCell className="text-right">
				<ProjectActionsMenu
					project={project}
					orgSlug={orgSlug}
					isFavorite={isFavorite}
					onToggleFavorite={onToggleFavorite}
					triggerClassName="ml-auto opacity-0 focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/row:opacity-100"
				/>
			</TableCell>
		</TableRow>
	);
}
