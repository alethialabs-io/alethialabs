"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project row — the table-view counterpart to `ProjectCard`. One project per row:
// provider glyph + name, cloud, region, status, estimated cost, and last-activity time.

import { formatDistanceToNow } from "date-fns";
import { Box, Star } from "lucide-react";
import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { TableCell, TableRow } from "@repo/ui/table";
import type { ProjectListItem } from "@/app/server/actions/projects";
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
}: {
	project: ProjectListItem;
	orgSlug: string;
	isFavorite: boolean;
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
							<ProviderIcon
								provider={provider}
								size={13}
								className="opacity-90 grayscale"
							/>
						) : (
							<Box className="h-3 w-3" />
						)}
					</span>
					<span className="truncate font-display text-[13px] font-medium text-foreground group-hover/row:underline">
						{project.project_name}
					</span>
					{isFavorite && (
						<Star className="h-3 w-3 shrink-0 fill-current text-muted-foreground" />
					)}
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
			<TableCell className="text-right font-mono text-[11px] text-muted-foreground">
				{project.estimated_monthly_cost
					? `$${project.estimated_monthly_cost.toFixed(2)}`
					: "—"}
			</TableCell>
			<TableCell className="text-right font-mono text-[11px] text-muted-foreground">
				{formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
			</TableCell>
		</TableRow>
	);
}
