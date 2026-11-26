"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { orpc } from "@/lib/rpc/client";
import { AlertsCardSkeleton } from "./alerts-card";
import { ProjectsSkeleton } from "./projects-skeleton";
import { RecentJobsCardSkeleton } from "./recent-jobs-card";
import { UsageCardSkeleton } from "./usage-card";

/**
 * The shell's answer to one of its reads, from the cache only. `enabled: false` makes this an
 * observer that never fetches: the `[org]` layout prefetches these reads and hydrates them above
 * the route's loading boundary, so on the server and on a soft navigation alike the answer is
 * already here — and if it is not, a skeleton is no reason to issue a read.
 */
function useShellAnswers() {
	const projects = useQuery(orpc.workspace.projects.queryOptions({ enabled: false })).data;
	const jobs = useQuery(orpc.workspace.recentJobs.queryOptions({ enabled: false })).data;
	const context = useQuery(orpc.workspace.context.queryOptions({ enabled: false })).data;
	return {
		projectCount: projects?.length,
		jobCount: jobs?.length,
		alerting: context?.entitlements.alerting,
	};
}

/**
 * The org overview's loading state (`app/(private)/[org]/loading.tsx`): the page's own layout, so
 * nothing moves when it answers (RUBRIC B2) — the one-row `ListToolbar`, then the two columns, with as
 * many blocks side by side as the page will set.
 *
 * The page's SHAPE depends on data the shell already holds, and drawing a guess where the answer is
 * known is what made this skeleton set three blocks side by side over a page that set two (#6347):
 * four project cards in a two-wide grid over an org with one project. So the shape is read from the
 * shell's cached reads, never fetched:
 *
 * - the projects area (`ProjectsSkeleton`, which the grid's own pending render also draws): one
 *   card placeholder per project (up to `MAX_PROJECT_PLACEHOLDERS`), or the "No projects yet"
 *   panel's height in plain bars when the org has none;
 * - the Recent-jobs card: one row per job in the shell's feed, or the empty line's height;
 * - the Alerts card: the plan gate's shape when the org's plan has no alerting, rows otherwise.
 *
 * What the shell cannot say — the search/filter result, the table view, how many alert deliveries
 * there are — keeps the default shape.
 */
export function OverviewSkeleton() {
	const { projectCount, jobCount, alerting } = useShellAnswers();
	return (
		<SkeletonRoot className="space-y-5">
			{/* The toolbar row: search, the Cloud and Repository facets, then the view toggle and the
			    two actions (sort, Create) — the real `ListToolbar`'s parts, from its own layout. */}
			<ListToolbarSkeleton facets={2} view actions={2} />
			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				<div className="flex flex-col gap-4">
					<UsageCardSkeleton />
					<AlertsCardSkeleton gated={alerting === false} />
					<RecentJobsCardSkeleton rows={jobCount} />
				</div>
				<div>
					<Skeleton className="mb-3 h-[22px] w-28" />
					<ProjectsSkeleton count={projectCount} />
				</div>
			</div>
		</SkeletonRoot>
	);
}
