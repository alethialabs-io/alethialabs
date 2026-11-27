// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the Activity routes' `loading.tsx` render this, and they are server components.

import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * One month heading and its rows (an avatar, a line, a relative time) — the feed's body while it has
 * no rows to show. `ActivityLog` draws this under its filter bar on a first load, and
 * {@link ActivityFeedSkeleton} draws it under the toolbar and bar it stands in for.
 */
export function ActivityRowsSkeleton({ rows = 8 }: { rows?: number }) {
	return (
		<div aria-hidden className="flex flex-col gap-1">
			<Skeleton className="mb-1 h-4 w-28" />
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex items-center gap-2 py-1">
					<Skeleton className="size-6 shrink-0 rounded-full" />
					<Skeleton className="h-4 flex-1" />
					<Skeleton className="h-3 w-24 shrink-0" />
				</div>
			))}
		</div>
	);
}

/**
 * The loading form of the Activity feed (#6129, RUBRIC B2), in the order and the boxes
 * `ActivityLog` renders: the one toolbar row (`ListToolbarSkeleton`) — the search box, one control per
 * facet (`facets`: Member, Project, Events on the org feed; Member and Events on a project's), the
 * quick-range and calendar controls and, on the org feed, Export (`exportSlot`) on the right — then
 * the rows.
 */
export function ActivityFeedSkeleton({
	facets,
	exportSlot = true,
	rows = 8,
}: {
	facets: number;
	exportSlot?: boolean;
	rows?: number;
}) {
	return (
		<SkeletonRoot>
			{/* The quick range is one more control than `dateRange` draws, so it counts as a facet. */}
			<ListToolbarSkeleton facets={facets + 1} dateRange actions={exportSlot ? 1 : 0} />
			<ActivityRowsSkeleton rows={rows} />
		</SkeletonRoot>
	);
}
