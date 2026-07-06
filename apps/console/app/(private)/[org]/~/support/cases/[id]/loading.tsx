// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton shown while the case-detail route prefetches on the server. Mirrors the
 * loaded layout — header block, conversation bubbles, and reply composer — so the swap to
 * real data doesn't shift the page.
 */
export default function CaseDetailLoading() {
	return (
		<div className="flex flex-col gap-6">
			{/* Header */}
			<div className="space-y-4">
				<Skeleton className="h-7 w-24" />
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-2">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-5 w-64" />
						<div className="flex items-center gap-2">
							<Skeleton className="h-5 w-16 rounded-none" />
							<Skeleton className="h-5 w-14 rounded-none" />
							<Skeleton className="h-3 w-40" />
						</div>
					</div>
					<Skeleton className="h-8 w-24 rounded-md" />
				</div>
			</div>

			{/* Thread */}
			<div className="space-y-8 rounded-md border p-4">
				{Array.from({ length: 3 }).map((_, i) => (
					<div
						key={i}
						className={i % 2 === 0 ? "space-y-2" : "ml-auto w-3/4 space-y-2"}
					>
						<Skeleton className="h-3 w-32" />
						<Skeleton className="h-16 w-full" />
					</div>
				))}
			</div>

			{/* Composer */}
			<div className="space-y-2">
				<Skeleton className="h-24 w-full rounded-md" />
				<div className="flex justify-end">
					<Skeleton className="h-8 w-20 rounded-md" />
				</div>
			</div>
		</div>
	);
}
