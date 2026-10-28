// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for Settings · Classification, while the page prefetches the org's taxonomy.
 *
 * In the manager's own shape (#6129, B2): the toolbar (the search box, the dimension count, the docs
 * affordance and New dimension on the right), then the master/detail — the dimension rail
 * (`lg:grid-cols-[296px_1fr]`, as the manager lays it out) and the selected dimension's detail
 * pane. It used to draw a stack of per-dimension panels, a layout this page does not have.
 */
export default function ClassificationLoading() {
	return (
		<div aria-busy>
			<div aria-hidden className="mb-4 flex items-center gap-2.5">
				<Skeleton className="h-9 w-[240px] rounded-sm" />
				<Skeleton className="h-3 w-24" />
				<div className="flex-1" />
				<Skeleton className="size-9 rounded-sm" />
				<Skeleton className="h-8 w-32 rounded-md" />
			</div>
			<div aria-hidden className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
				<div className="space-y-1.5 rounded-lg border p-2">
					{[1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-12 w-full rounded-md" />
					))}
				</div>
				<div className="rounded-lg border">
					<div className="space-y-2 p-5">
						<Skeleton className="h-5 w-40" />
						<Skeleton className="h-3 w-64" />
					</div>
					<div className="space-y-2 border-t p-5">
						{[1, 2, 3, 4].map((i) => (
							<Skeleton key={i} className="h-9 w-full" />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
