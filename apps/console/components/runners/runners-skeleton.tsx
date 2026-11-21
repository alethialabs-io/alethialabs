// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { PoolCardSkeleton } from "@/components/runners/pool-card";
import { RUNNERS_COLUMNS, RUNNERS_GRID } from "@/components/runners/runners-layout";
import { RunnerCardSkeleton } from "@/components/runners/runner-card";
import { VersionsPanelSkeletonBody } from "@/components/runners/versions-panel";

/**
 * The runners page while its reads are prefetched — the page's OWN layout (RUBRIC B2): the same two
 * columns, the Pools section only where the page renders one (a self-managed deployment), the
 * Versions panel's frame, then the "Runners" heading row, the filter bar's row and the card grid.
 *
 * Rendered only once the server knows the viewer is entitled to the page (`page.tsx`): a plan
 * without BYO runners renders the upsell instead, so this never promises a grid that will not come
 * (F021). The route's `loading.tsx` shows before that is known: on a hosted deployment it promises
 * nothing; on a self-managed one, which is never gated, it draws this skeleton too.
 */
export function RunnersSkeleton({ hosted }: { hosted: boolean }) {
	return (
		<SkeletonRoot className={RUNNERS_COLUMNS}>
			<span className="sr-only">Loading runners</span>
			<div className="flex flex-col gap-6">
				{!hosted && (
					<section className="space-y-3">
						<Skeleton className="h-5 w-24" />
						<div className="space-y-4">
							<PoolCardSkeleton />
							<PoolCardSkeleton />
						</div>
					</section>
				)}
				<VersionsPanelSkeletonBody />
			</div>
			<div className="min-w-0 space-y-4">
				<div className="flex items-center justify-between">
					<Skeleton className="h-6 w-28" />
					<Skeleton className="h-9 w-28 rounded-md" />
				</div>
				<Skeleton className="h-9 w-full rounded-md" />
				<div className={RUNNERS_GRID}>
					{[1, 2, 3, 4].map((i) => (
						<RunnerCardSkeleton key={i} />
					))}
				</div>
			</div>
		</SkeletonRoot>
	);
}
