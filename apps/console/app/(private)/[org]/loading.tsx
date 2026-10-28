// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { AlertsCardSkeleton } from "@/components/overview/alerts-card";
import { RecentJobsCardSkeleton } from "@/components/overview/recent-jobs-card";
import { UsageCardSkeleton } from "@/components/overview/usage-card";

/**
 * Instant skeleton shown while the org overview prefetches on the server — the page's own layout,
 * so nothing moves when it answers (RUBRIC B2): the filter bar's row (search, filter, view toggle,
 * Create), then the two columns. The left column is the three cards' OWN pending renders — their
 * real frames and header strips with row placeholders at the rows' real heights — not three grey
 * boxes of guessed heights; the right is the "Projects" heading and the card grid.
 */
export default function OverviewLoading() {
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
					<AlertsCardSkeleton />
					<RecentJobsCardSkeleton />
				</div>
				<div>
					<Skeleton className="mb-3 h-[22px] w-28" />
					<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
						{[1, 2, 3, 4].map((i) => (
							<Skeleton key={i} className="h-32 w-full rounded-lg" />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
