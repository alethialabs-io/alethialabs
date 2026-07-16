// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the Evidence route prefetches the roll-up — mirrors
 * the page's real layout: filter bar, Environments heading + pill, the posture table,
 * and the waivers panel. */
export default function EvidenceLoading() {
	return (
		<div className="space-y-4 pb-20">
			<div className="flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-9 w-[240px] flex-1 rounded-sm" />
				<Skeleton className="h-8 w-40 rounded-md" />
				<Skeleton className="h-7 w-24 rounded-full" />
				<Skeleton className="h-7 w-20 rounded-full" />
				<Skeleton className="h-8 w-24 rounded-md" />
			</div>
			<div className="flex items-center gap-2.5 pt-2">
				<Skeleton className="h-5 w-32 rounded-sm" />
				<Skeleton className="h-5 w-8 rounded-full" />
			</div>
			<Skeleton className="h-72 w-full rounded-lg" />
			<Skeleton className="h-40 w-full rounded-lg" />
		</div>
	);
}
