"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@repo/ui/skeleton";
import { orpc } from "@/lib/rpc/client";
import { AlertsCardSkeleton } from "./alerts-card";
import { RecentJobsCardSkeleton } from "./recent-jobs-card";
import { UsageCardSkeleton } from "./usage-card";

/** The most project cards the skeleton draws — past the second row they are below the fold. */
const MAX_PROJECT_PLACEHOLDERS = 6;

/** Project cards drawn when the shell's project list is not in the cache (its prefetch failed). */
const UNKNOWN_PROJECT_PLACEHOLDERS = 2;

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
 * nothing moves when it answers (RUBRIC B2) — the filter bar's row, then the two columns, with as
 * many blocks side by side as the page will set.
 *
 * The page's SHAPE depends on data the shell already holds, and drawing a guess where the answer is
 * known is what made this skeleton set three blocks side by side over a page that set two (#6347):
 * four project cards in a two-wide grid over an org with one project. So the shape is read from the
 * shell's cached reads, never fetched:
 *
 * - the projects area: one card placeholder per project (up to `MAX_PROJECT_PLACEHOLDERS`), or the
 *   "No projects yet" panel's height in plain bars when the org has none;
 * - the Recent-jobs card: one row per job in the shell's feed, or the empty line's height;
 * - the Alerts card: the plan gate's shape when the org's plan has no alerting, rows otherwise.
 *
 * What the shell cannot say — the search/filter result, the table view, how many alert deliveries
 * there are — keeps the default shape.
 */
export function OverviewSkeleton() {
	const { projectCount, jobCount, alerting } = useShellAnswers();
	return (
		<div className="space-y-5" aria-busy="true">
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-9 min-w-[200px] flex-1 rounded-sm" />
				<Skeleton className="h-9 w-9 rounded-sm" />
				<div className="ml-auto flex items-center gap-2.5">
					<Skeleton className="h-9 w-16 rounded-sm" />
					<Skeleton className="h-9 w-24 rounded-md" />
				</div>
			</div>
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
		</div>
	);
}

/**
 * The projects area: `count` card placeholders in the page's grid, or — for an org with no
 * projects — the "No projects yet" panel's height (`EmptyState`'s padding and gaps around its icon
 * tile, title, two description lines and button) drawn as plain bars, with no frame and no empty
 * copy: the panel has no frame, and a pending page must not say there is nothing (RUBRIC B3).
 */
function ProjectsSkeleton({ count }: { count: number | undefined }) {
	if (count === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-6 p-6 md:p-12" data-testid="projects-empty-skeleton">
				<div className="flex flex-col items-center gap-2">
					<Skeleton className="mb-2 size-10 rounded-lg" />
					<Skeleton className="h-7 w-40" />
					<div className="flex flex-col items-center gap-1">
						<Skeleton className="h-5 w-72 max-w-full" />
						<Skeleton className="h-5 w-56 max-w-full" />
					</div>
				</div>
				<Skeleton className="h-8 w-36" />
			</div>
		);
	}
	const cards = Math.min(count ?? UNKNOWN_PROJECT_PLACEHOLDERS, MAX_PROJECT_PLACEHOLDERS);
	return (
		<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
			{Array.from({ length: cards }, (_, i) => (
				<Skeleton key={i} className="h-32 w-full rounded-lg" data-testid="project-card-skeleton" />
			))}
		</div>
	);
}
