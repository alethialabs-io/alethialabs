// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton shown while the "My cases" route prefetches on the server. Mirrors the
 * loaded layout — the status tab strip and a bordered list of case rows — so the swap to
 * real data doesn't shift the page.
 */
export default function MyCasesLoading() {
	return (
		<div className="space-y-4">
			{/* Status tabs */}
			<Skeleton className="h-9 w-64 rounded-md" />

			{/* Case rows */}
			<div className="overflow-hidden rounded-md border">
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						key={i}
						className="flex items-start gap-4 border-b border-border/60 px-4 py-3.5 last:border-b-0"
					>
						<Skeleton className="mt-1.5 size-2 rounded-full" />
						<div className="flex-1 space-y-2">
							<div className="flex items-center gap-2">
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-3 w-48" />
							</div>
							<Skeleton className="h-3 w-32" />
						</div>
						<div className="flex items-center gap-2">
							<Skeleton className="h-5 w-14 rounded-none" />
							<Skeleton className="h-5 w-16 rounded-none" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
