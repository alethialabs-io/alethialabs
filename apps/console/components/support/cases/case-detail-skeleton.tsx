// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * The case view's loading form — the route's `loading.tsx` and the view's own pending branch draw
 * this ONE component, so the two cannot disagree. Mirrors the loaded layout so the swap to real
 * data doesn't shift the page (#6354, B2):
 *
 * - the header: the back link (its ghost button's `-ml-2` box), the reference, the subject, the
 *   badge line and the actions button — and the classification row under them, a `size="sm"`
 *   "Classify" button. That row was missing, so the thread below sat 38px too high;
 * - the conversation, bordered, with ONE message: every case opens with the requester's own
 *   description (`submitCase` writes it as the first, customer-authored message), so one
 *   right-aligned bubble is the shape every thread has. Three were drawn, a 350px panel over a
 *   134px one; a longer thread grows below what the skeleton promised, it never shrinks above it;
 * - the composer: the reply box at its `min-h-24` floor, then the row with its reserved validation
 *   line and the `size="sm"` Send button, `space-y-1` apart as `CaseComposer` sets them.
 */
export function CaseDetailSkeleton() {
	return (
		<div className="flex flex-col gap-6" aria-busy="true">
			{/* Header */}
			<div className="space-y-4">
				<Skeleton className="-ml-2 h-7 w-24" />
				<div className="space-y-2">
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
					{/* Classification */}
					<Skeleton className="h-8 w-24 rounded-none" />
				</div>
			</div>

			{/* Thread — the requester's opening message */}
			<div className="rounded-md border p-4">
				<div className="ml-auto w-3/4 space-y-2">
					<div className="flex h-4 items-center justify-end">
						<Skeleton className="h-3 w-32" />
					</div>
					<Skeleton className="h-19 w-full rounded-none" />
				</div>
			</div>

			{/* Composer */}
			<div className="space-y-1">
				<Skeleton className="h-24 w-full rounded-none" />
				<div className="flex justify-end">
					<Skeleton className="h-8 w-20 rounded-none" />
				</div>
			</div>
		</div>
	);
}
