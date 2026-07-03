"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org root — an organization overview. A search/filter toolbar over the projects grid
// (right), alongside Usage / Alerts / Recent-jobs cards (left). Projects come from the
// shared `useProjectsQuery` cache; favorites are persisted in `useProjectsStore`.

import { Boxes, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { AlertsCard } from "@/components/overview/alerts-card";
import {
	type OverviewFilters,
	type OverviewSort,
	OverviewToolbar,
} from "@/components/overview/overview-toolbar";
import { ProjectCard } from "@/components/overview/project-card";
import { RecentJobsCard } from "@/components/overview/recent-jobs-card";
import { UsageCard } from "@/components/overview/usage-card";
import { globalHref } from "@/lib/routing";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { useProjectsStore } from "@/lib/stores/use-projects-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

export function OverviewClient() {
	const orgSlug = useActiveOrgSlug();
	const { data: projects = [], isPending: isLoading } = useProjectsQuery();
	const { favoriteProjectIds, toggleFavorite } = useProjectsStore();

	const [query, setQuery] = useState("");
	const [filters, setFilters] = useState<OverviewFilters>({
		clouds: [],
		regions: [],
	});
	const [sort, setSort] = useState<OverviewSort>("activity");

	// Decorate each project with its favorite state once, for filter + sort + render.
	const decorated = useMemo(
		() =>
			projects.map((project) => ({
				project,
				isFavorite: favoriteProjectIds.includes(project.id),
			})),
		[projects, favoriteProjectIds],
	);

	const availableClouds = useMemo(
		() =>
			Array.from(
				new Set(
					projects
						.map((p) => p.cloud_provider)
						.filter((p): p is string => p != null),
				),
			).sort(),
		[projects],
	);
	const availableRegions = useMemo(
		() =>
			Array.from(new Set(projects.map((p) => p.region).filter(Boolean))).sort(),
		[projects],
	);
	const projectCount = projects.length;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = decorated.filter(({ project }) => {
			if (
				q &&
				!project.project_name.toLowerCase().includes(q) &&
				!project.region?.toLowerCase().includes(q)
			)
				return false;
			if (
				filters.clouds.length &&
				!(project.cloud_provider && filters.clouds.includes(project.cloud_provider))
			)
				return false;
			if (filters.regions.length && !filters.regions.includes(project.region))
				return false;
			return true;
		});
		return list.sort((a, b) => {
			if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
			if (sort === "name")
				return a.project.project_name.localeCompare(b.project.project_name);
			// activity — newest update first
			return (
				new Date(b.project.updated_at).getTime() -
				new Date(a.project.updated_at).getTime()
			);
		});
	}, [decorated, query, filters, sort]);

	return (
		<div className="mx-auto w-full max-w-[1360px] space-y-5">
			<OverviewToolbar
				orgSlug={orgSlug}
				query={query}
				onQueryChange={setQuery}
				filters={filters}
				onFiltersChange={setFilters}
				sort={sort}
				onSortChange={setSort}
				availableClouds={availableClouds}
				availableRegions={availableRegions}
			/>

			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				{/* Left column — usage, alerts, recent jobs. */}
				<div className="flex flex-col gap-4">
					<UsageCard orgSlug={orgSlug} projectCount={projectCount} />
					<AlertsCard orgSlug={orgSlug} />
					<RecentJobsCard orgSlug={orgSlug} />
				</div>

				{/* Right column — projects grid. */}
				<div>
					<div className="mb-3 flex items-center gap-2.5">
						<span className="font-display text-[15px] font-semibold tracking-tight">
							Projects
						</span>
						<span className="rounded-full border px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
							{visible.length}
						</span>
					</div>

					{isLoading && projects.length === 0 ? (
						<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
							{[1, 2, 3].map((i) => (
								<Skeleton key={i} className="h-32 w-full rounded-lg" />
							))}
						</div>
					) : projects.length === 0 ? (
						<EmptyState orgSlug={orgSlug} />
					) : visible.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							No projects match your filters.
						</p>
					) : (
						<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
							{visible.map(({ project, isFavorite }) => (
								<ProjectCard
									key={project.id}
									project={project}
									orgSlug={orgSlug}
									isFavorite={isFavorite}
									onToggleFavorite={() => toggleFavorite(project.id)}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** First-run state when the org has no projects at all. */
function EmptyState({ orgSlug }: { orgSlug: string }) {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
			<div className="mb-4 rounded-full bg-muted/50 p-3">
				<Boxes className="h-7 w-7 text-muted-foreground" />
			</div>
			<h3 className="mb-1 text-sm font-medium text-foreground">
				No projects yet
			</h3>
			<p className="mb-4 max-w-sm text-xs text-muted-foreground">
				Create your first project to provision infrastructure — it becomes a project
				you can manage here.
			</p>
			<Link href={globalHref(orgSlug, "new")}>
				<Button size="sm" className="h-8 gap-1.5 text-xs">
					<Plus className="h-3.5 w-3.5" />
					Create a Project
				</Button>
			</Link>
		</div>
	);
}
