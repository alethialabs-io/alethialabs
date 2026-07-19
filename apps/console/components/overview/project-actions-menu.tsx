"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared ⋮ actions menu for a project, used by both the overview card and the table row so the
// two surfaces never drift. Routes to the project's Elench canvas / logs / settings, opens the
// duplicate-to-another-cloud dialog, and toggles the (browser-local) favourite.

import { Copy, MoreVertical, ScrollText, Settings, Sparkles, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { cn } from "@repo/ui/utils";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { DuplicateProjectDialog } from "@/components/projects/duplicate-project-dialog";
import { projectGlobalHref, projectHref } from "@/lib/routing";

/** The project actions dropdown. `triggerClassName` positions/reveals the trigger per surface. */
export function ProjectActionsMenu({
	project,
	orgSlug,
	isFavorite,
	onToggleFavorite,
	triggerClassName,
}: {
	project: ProjectListItem;
	orgSlug: string;
	isFavorite: boolean;
	onToggleFavorite: () => void;
	triggerClassName?: string;
}) {
	const router = useRouter();
	const [duplicateOpen, setDuplicateOpen] = useState(false);
	const slug = project.slug;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`${project.project_name} actions`}
					className={cn(
						"grid size-6 place-items-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
						triggerClassName,
					)}
				>
					<MoreVertical className="h-3.5 w-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					<DropdownMenuItem
						disabled={!slug}
						onSelect={() => slug && router.push(projectHref(orgSlug, slug))}
					>
						<Sparkles className="mr-2 h-3.5 w-3.5" />
						Open in Elench
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!slug}
						onSelect={() =>
							slug && router.push(projectGlobalHref(orgSlug, slug, "jobs"))
						}
					>
						<ScrollText className="mr-2 h-3.5 w-3.5" />
						View Logs
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!slug}
						onSelect={() =>
							slug && router.push(projectGlobalHref(orgSlug, slug, "settings"))
						}
					>
						<Settings className="mr-2 h-3.5 w-3.5" />
						Settings
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!slug}
						onSelect={() => setDuplicateOpen(true)}
					>
						<Copy className="mr-2 h-3.5 w-3.5" />
						Duplicate to another cloud…
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => onToggleFavorite()}>
						<Star
							className={cn("mr-2 h-3.5 w-3.5", isFavorite && "fill-current")}
						/>
						{isFavorite ? "Remove from Favourites" : "Add to Favourites"}
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
		</>
	);
}
