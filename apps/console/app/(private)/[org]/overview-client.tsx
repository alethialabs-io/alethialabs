"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org root: the organization's overview. A search and filter toolbar over the project grid
// (right, cards or a table), beside the Usage, Alerts and Recent-jobs cards (left).
//
// The grid's search, filters, sort and view live in the address. The grid itself is a keyset walk
// (`useOverviewProjects`, one page at a time) whose first page the route prefetches for that
// address, so it paints with its rows and then follows the organization's change stream: a project
// created elsewhere, or a status a deploy moved, arrives without a reload (lib/realtime/README.md,
// rule 1). Its summary (`useOverviewProjectsSummary`) carries what is not a property of a page:
// the create permission, the connected and offered clouds, and the Usage card's project count.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";
import { AlertsCard } from "@/components/overview/alerts-card";
import { type OverviewState, overviewSearch } from "@/components/overview/overview-state";
import { OverviewToolbar } from "@/components/overview/overview-toolbar";
import { PROJECTS_HEADING, ProjectsGrid } from "@/components/overview/projects-grid";
import { RecentJobsCard } from "@/components/overview/recent-jobs-card";
import { UsageCard } from "@/components/overview/usage-card";
import {
	createProjectReason,
	useOverviewProjects,
	useOverviewProjectsSummary,
} from "@/components/overview/use-overview-projects";

/** No facets: what the toolbar's filter lists while the grid's first page has not answered. */
const NO_FACETS = { clouds: [], repos: [] };

/** The overview page for one address: `state` is the grid's state as the route read it. */
export function OverviewClient({
	orgSlug,
	state,
	jobsPrefetched = false,
}: {
	orgSlug: string;
	state: OverviewState;
	/**
	 * The page handed the Recent-jobs feed down in its own boundary, so the card draws it on the
	 * server. Absent means "not known", and the card keeps to its pending frame until hydration.
	 */
	jobsPrefetched?: boolean;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const [navigating, startTransition] = useTransition();
	const list = useOverviewProjects(state);
	const summary = useOverviewProjectsSummary();

	// Merge a partial change into the address. The route re-reads the grid for the new address and
	// hands it down, so the browser's read of the same input is answered from that.
	const onChange = useCallback(
		(next: Partial<OverviewState>) => {
			const search = overviewSearch({ ...state, ...next });
			startTransition(() => router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false }));
		},
		[state, pathname, router],
	);
	const clearFilters = useCallback(() => onChange({ q: "", clouds: [], repos: [] }), [onChange]);

	return (
		<div className="space-y-5">
			<OverviewToolbar
				orgSlug={orgSlug}
				state={state}
				facets={list.facets ?? NO_FACETS}
				createProjectReason={createProjectReason(summary)}
				onChange={onChange}
			/>

			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				{/* Left column: usage, alerts, recent jobs. Each card owns its own read and its own
				    failure, so none of them can take the page down. */}
				<div className="flex flex-col gap-4">
					<UsageCard orgSlug={orgSlug} projectCount={summary.data?.projectCount} />
					<AlertsCard orgSlug={orgSlug} />
					<RecentJobsCard orgSlug={orgSlug} prefetched={jobsPrefetched} />
				</div>

				{/* Right column: the projects. "Projects" names a SECTION of the overview, not the route
				    (the breadcrumb says "Overview"). No count beside it: the list carries none
				    (lib/query/README.md → "Counts", the maintainer's 2026-11-24 ruling, #7481). */}
				<section aria-label={PROJECTS_HEADING}>
					<SectionHeading title={PROJECTS_HEADING} className="mb-3" />
					<div className={cn("transition-opacity", navigating && "opacity-60")}>
						<ProjectsGrid
							orgSlug={orgSlug}
							state={state}
							list={list}
							summary={summary}
							onClearFilters={clearFilters}
						/>
					</div>
				</section>
			</div>
		</div>
	);
}
