// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { CaseListSkeletonRows } from "@/components/support/cases/case-list-skeleton";

/**
 * Instant skeleton shown while the "My cases" route prefetches on the server. Mirrors the loaded
 * layout of `CaseList`: the page toolbar (count, one line of copy, the "Submit a case" button),
 * the filter bar (search, the three bucket chips, the two facet buttons — `FilterBar`'s row with
 * its `mb-4`), and the bordered list of case rows — so the swap to real data doesn't shift the page.
 */
export default function MyCasesLoading() {
	return (
		<div className="space-y-4">
			<PageToolbarSkeleton count actions={1} />

			<div className="mb-4 flex flex-wrap items-center gap-2.5" aria-hidden>
				<Skeleton className="h-9 w-[240px] rounded-sm" />
				<div className="flex items-center gap-1.5">
					{["w-11", "w-16", "w-[4.5rem]"].map((w) => (
						<Skeleton key={w} className={`h-7 ${w} rounded-full`} />
					))}
				</div>
				<Skeleton className="h-8 w-24 rounded-md" />
				<Skeleton className="h-8 w-20 rounded-md" />
			</div>

			<CaseListSkeletonRows />
		</div>
	);
}
