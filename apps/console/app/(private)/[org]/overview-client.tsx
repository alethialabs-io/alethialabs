"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org root: the organization's overview. A search and filter toolbar over the project grid
// (right, cards or a table), beside the Usage, Alerts and Recent-jobs cards (left).
//
// The grid's search, filters, sort and view live in the address. The grid itself is a query
// (`useOverviewProjects`) that the route prefetches for that address, so it paints with its rows
// and then follows the organization's change stream: a project created elsewhere, or a status a
// deploy moved, arrives without a reload (lib/realtime/README.md, rule 1).

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";
import { MANAGE_DENIED_REASON, MANAGE_PENDING_REASON } from "@/components/errors/manage-gate";
import { AlertsCard } from "@/components/overview/alerts-card";
import { type OverviewState, overviewSearch } from "@/components/overview/overview-state";
import { OverviewToolbar } from "@/components/overview/overview-toolbar";
import { PROJECTS_HEADING, ProjectsGrid } from "@/components/overview/projects-grid";
import { RecentJobsCard } from "@/components/overview/recent-jobs-card";
import { UsageCard } from "@/components/overview/usage-card";
import { useOverviewProjects } from "@/components/overview/use-overview-projects";

/** No facets: what the toolbar's filter lists while the grid's read has not answered. */
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
	const grid = useOverviewProjects(state);

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

	// Disabled with a reason until the server has said the viewer may create a project. A read
	// that failed says nothing either way, so the entry is left usable: `~/new` decides for itself.
	const createProjectReason =
		grid.data === undefined
			? grid.isError
				? null
				: MANAGE_PENDING_REASON
			: grid.data.canCreate
				? null
				: MANAGE_DENIED_REASON;

	return (
		<div className="space-y-5">
			<OverviewToolbar
				orgSlug={orgSlug}
				state={state}
				facets={grid.data?.facets ?? NO_FACETS}
				createProjectReason={createProjectReason}
				onChange={onChange}
			/>

			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				{/* Left column: usage, alerts, recent jobs. Each card owns its own read and its own
				    failure, so none of them can take the page down. */}
				<div className="flex flex-col gap-4">
					<UsageCard orgSlug={orgSlug} projectCount={grid.data?.total} />
					<AlertsCard orgSlug={orgSlug} />
					<RecentJobsCard orgSlug={orgSlug} prefetched={jobsPrefetched} />
				</div>

				{/* Right column: the projects. "Projects" names a SECTION of the overview, not the route
				    (the breadcrumb says "Overview"). The count is the number of projects shown, in the
				    shared count pill beside the heading, where the console filter standard puts it. */}
				<section aria-label={PROJECTS_HEADING}>
					<SectionHeading title={PROJECTS_HEADING} count={grid.data?.projects.length} className="mb-3" />
					<div className={cn("transition-opacity", navigating && "opacity-60")}>
						<ProjectsGrid orgSlug={orgSlug} state={state} grid={grid} onClearFilters={clearFilters} />
					</div>
				</section>
			</div>
		</div>
	);
}
