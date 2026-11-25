// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the route's `loading.tsx` and the board's own pending render draw this one
// skeleton, so the two cannot disagree about the layout they promise.

import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/** One agent card: the frame and the two rows `AgentCard` draws. */
function AgentCardSkeleton() {
	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background p-4 shadow-sm">
			<div className="flex items-start gap-3">
				<Skeleton className="size-9 shrink-0 rounded-lg" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-3 w-full max-w-52" />
				</div>
			</div>
			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-3">
				<Skeleton className="h-4 w-28 rounded-full" />
				<Skeleton className="h-7 w-16 rounded-md" />
			</div>
		</div>
	);
}

/** The connected-agents board while its read is pending: toolbar, filter bar and six cards. */
export function ConnectedAgentsSkeleton() {
	return (
		<SkeletonRoot data-skeleton="connected-agents" className="space-y-4">
			<PageToolbarSkeleton />
			<div className="flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-9 w-[220px] rounded-md" />
				<Skeleton className="h-9 w-24 rounded-md" />
			</div>
			<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
				{Array.from({ length: 6 }, (_, i) => (
					<AgentCardSkeleton key={i} />
				))}
			</div>
		</SkeletonRoot>
	);
}
