// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * The consent screen while it loads (SPEC §5b, case 22): a skeleton of the column — eyebrow,
 * heading, the account card, the app's identity, and the block of choices — so the answered screen
 * does not jump when it arrives.
 */
export function ConsentSkeleton() {
	return (
		<SkeletonRoot className="space-y-5">
			<div className="space-y-3">
				<Skeleton className="h-3 w-24" />
				<Skeleton className="h-9 w-4/5" />
				<Skeleton className="h-5 w-full" />
			</div>
			<Skeleton className="h-14 w-full rounded-lg" />
			<Skeleton className="h-16 w-full rounded-lg" />
			<Skeleton className="h-44 w-full rounded-lg" />
			<div className="flex gap-2">
				<Skeleton className="h-12 flex-1" />
				<Skeleton className="h-12 flex-1" />
			</div>
		</SkeletonRoot>
	);
}
