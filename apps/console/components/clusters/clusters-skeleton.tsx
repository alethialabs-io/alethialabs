// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * The clusters grid before its read answers — the route's `loading.tsx` and the grid's own pending
 * render share it, so the two can never disagree (RUBRIC B2). Each placeholder is a `ClusterCard`'s
 * frame at the card's own padding and rhythm: the header (provider mark, name and posture, the meta
 * line, the chips row) with the rollup on the right, the component rows, then the access block.
 * No heading: the surface opens straight into content.
 */
export function ClustersSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true">
			{[0, 1].map((i) => (
				<div key={i} className="flex flex-col gap-3.5 rounded-lg border bg-surface p-[18px] shadow-sm">
					<div className="flex items-start justify-between gap-3">
						<div className="flex min-w-0 items-start gap-2.5">
							<Skeleton className="size-5 rounded-sm" />
							<div className="space-y-1.5">
								<div className="flex items-center gap-2">
									<Skeleton className="h-5 w-32" />
									<Skeleton className="h-5 w-16 rounded-full" />
								</div>
								<Skeleton className="h-3 w-48" />
								<Skeleton className="h-5 w-24" />
							</div>
						</div>
						<div className="flex flex-col items-end gap-1">
							<Skeleton className="h-5 w-20 rounded-full" />
							<Skeleton className="h-3 w-16" />
						</div>
					</div>
					<div className="flex flex-col gap-3 border-t pt-3">
						<Skeleton className="h-5 w-full" />
						<Skeleton className="h-5 w-full" />
					</div>
					<div className="flex flex-col gap-1.5 border-t pt-3">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-7 w-full" />
						<Skeleton className="h-7 w-full" />
					</div>
				</div>
			))}
		</div>
	);
}
