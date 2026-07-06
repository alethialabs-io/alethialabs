// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Width of each faux filter control, mirroring the real range picker + combobox chips. */
const FILTER_WIDTHS = ["w-32", "w-28", "w-40", "w-40", "w-40", "w-40"];

/**
 * Instant skeleton shown while the jobs route prefetches on the server. Mirrors the loaded
 * layout — the filter chip row and the `DataTable` (header + rows) — so the swap to real data
 * doesn't shift the page.
 */
export default function JobsLoading() {
	return (
		<div className="space-y-6">
			{/* Filter row — h-8 controls matching QuickRange/DateRange/MultiCombobox. */}
			<div className="flex flex-wrap items-center gap-2.5">
				{FILTER_WIDTHS.map((w, i) => (
					<Skeleton key={i} className={`h-8 ${w} rounded-md`} />
				))}
			</div>

			{/* Table — mirrors DataTable's bordered, scroll-height container. */}
			<div className="h-[70vh] overflow-hidden rounded-md border">
				{/* Header row */}
				<div className="flex items-center gap-4 border-b bg-background p-3">
					{["w-12", "w-14", "w-16", "w-14", "w-20", "w-16"].map((w, i) => (
						<Skeleton
							key={i}
							className={`h-3 ${w} ${i === 5 ? "ml-auto" : ""}`}
						/>
					))}
				</div>
				{/* Body rows */}
				{Array.from({ length: 11 }).map((_, i) => (
					<div
						key={i}
						className="flex items-center gap-4 border-b border-border/40 p-3"
					>
						{/* Type: icon + label */}
						<div className="flex items-center gap-2">
							<Skeleton className="size-3.5 rounded-sm" />
							<Skeleton className="h-3 w-20" />
						</div>
						{/* Status: pill + duration */}
						<div className="flex items-center gap-2">
							<Skeleton className="h-4 w-16 rounded-full" />
							<Skeleton className="h-3 w-10" />
						</div>
						{/* Project */}
						<Skeleton className="h-3 w-24" />
						{/* Runner */}
						<Skeleton className="h-3 w-16" />
						{/* Environment */}
						<Skeleton className="h-3 w-20" />
						{/* Initiated: timestamp + avatar, right-aligned */}
						<div className="ml-auto flex items-center gap-2">
							<Skeleton className="h-3 w-20" />
							<Skeleton className="size-6 rounded-full" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
