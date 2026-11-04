// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the route's `loading.tsx` (a server component) and the board's own pending
// render draw this one skeleton, so the two cannot disagree about the layout they promise.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * The groups the skeleton draws, with the number of tiles each shows. The board renders one section
 * per presentation group in `GROUP_META` order and the catalog opens with Clouds and Source, so
 * these two are what the first screen holds when it lands.
 */
const SKELETON_GROUPS = [7, 3];

/** One connector tile — the frame and the two rows `ConnectorCard` draws. */
function ConnectorTileSkeleton() {
	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background p-4 shadow-sm">
			<div className="flex items-start gap-3">
				<Skeleton className="size-9 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-3 w-full max-w-52" />
					<Skeleton className="h-3 w-3/4 max-w-40" />
				</div>
			</div>
			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-3">
				<Skeleton className="h-4 w-28 rounded-full" />
				<Skeleton className="h-7 w-20 rounded-md" />
			</div>
		</div>
	);
}

/**
 * The connectors board while its read is pending: the toolbar (count + description), the filter
 * bar (search, the status chips, the group and vendor pickers, then the view toggle and the docs
 * link at the end), and the first group sections as card grids — the board's default view.
 */
export function ConnectorsSkeleton() {
	return (
		<div data-slot="connectors-skeleton" aria-hidden className="space-y-6">
			<PageToolbarSkeleton count />

			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-9 w-[200px] rounded-md" />
				<Skeleton className="h-8 w-24 rounded-full" />
				<Skeleton className="h-8 w-24 rounded-full" />
				<Skeleton className="h-9 w-24 rounded-md" />
				<Skeleton className="h-9 w-32 rounded-md" />
				<div className="ml-auto flex items-center gap-2.5">
					<Skeleton className="h-9 w-[72px] rounded-md" />
					<Skeleton className="size-9 rounded-md" />
				</div>
			</div>

			<div className="space-y-6">
				{SKELETON_GROUPS.map((tiles, g) => (
					<section key={g} className="space-y-3.5">
						<div className="flex items-center gap-3">
							<Skeleton className="size-7 shrink-0 rounded-md" />
							<Skeleton className="h-4 w-28" />
							<Skeleton className="ml-auto h-3 w-20" />
						</div>
						<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
							{Array.from({ length: tiles }, (_, i) => (
								<ConnectorTileSkeleton key={i} />
							))}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}
