// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Placeholder case rows, drawn with `CaseListItem`'s own box (padding, border, the unread-dot
 * column, the two text lines and the two badges) so the list does not move when the rows land.
 * The route's `loading.tsx` draws it under the toolbar and filter-bar placeholders; `CaseList`
 * draws it while its read is pending, which it only is when no prefetch reached it.
 */
export function CaseListSkeletonRows({ rows = 6 }: { rows?: number }) {
	return (
		<div className="overflow-hidden rounded-md border" aria-busy="true">
			{Array.from({ length: rows }).map((_, i) => (
				<div
					key={i}
					className="flex items-start gap-4 border-b border-border/60 px-4 py-3.5 last:border-b-0"
				>
					<span className="mt-1.5 size-2 shrink-0" />
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex h-5 items-center gap-2">
							<Skeleton className="h-3 w-20" />
							<Skeleton className="h-3 w-48" />
						</div>
						<div className="flex h-4 items-center">
							<Skeleton className="h-3 w-32" />
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Skeleton className="h-5 w-14 rounded-none" />
						<Skeleton className="h-5 w-16 rounded-none" />
					</div>
				</div>
			))}
		</div>
	);
}
