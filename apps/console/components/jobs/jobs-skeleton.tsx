// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": both jobs routes' `loading.tsx` render this, and they are server components.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/**
 * The loading form of the jobs list (`JobsClient`), in the order and the boxes it renders:
 *
 * - the toolbar — a result count and ONE line of description;
 * - the filter bar — search, quick range, date range, then a combobox per facet: authors,
 *   environments, projects (org route only), statuses, types; every control is `h-8`;
 * - the table in its fixed `h-[70vh]` frame — Type, Status, Project (org route only), Runner,
 *   Environment, Initiated. The frame's height is fixed, so the rows landing cannot move anything
 *   below or beside it.
 *
 * `showProject` is false on a project's own jobs route, which drops the Project facet and column
 * exactly as `JobsClient` does when given a `projectId`.
 */
export function JobsListSkeleton({ showProject = true }: { showProject?: boolean }) {
	const facets = showProject ? 5 : 4;
	return (
		<div className="space-y-6" aria-busy>
			<PageToolbarSkeleton count />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				{/* FilterSearch: `w-[220px] max-w-[340px] flex-1`. */}
				<Skeleton className="h-8 w-[220px] max-w-[340px] flex-1 rounded-md" />
				{/* QuickRangeFilter, then DateRangeFilter. */}
				<Skeleton className="h-8 w-32 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
				{Array.from({ length: facets }, (_, i) => (
					<Skeleton key={i} className="h-8 w-36 rounded-md" />
				))}
			</div>
			<DataTableSkeleton columns={showProject ? 6 : 5} rows={11} scrollHeight="h-[70vh]" />
		</div>
	);
}
