// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for a single job.
 *
 * Without this file the route inherited `../loading.tsx` — the jobs LIST skeleton, a filter chip
 * row over a six-column table — which is not the shape of anything on this page. The job view is a
 * full-height log surface: a status header bar, then the streamed log column. It breaks out of the
 * shell padding with the same negative margins the page uses, so the swap does not shift.
 */
export default function JobDetailLoading() {
	return (
		<div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col sm:-m-6 lg:-m-8 xl:-m-10">
			{/* Header — icon, status pill + meta, and the action buttons. */}
			<div className="shrink-0 border-b border-border/40 bg-muted/5 px-6 py-4">
				<div className="flex items-start gap-3">
					<Skeleton className="mt-0.5 size-5 shrink-0 rounded-sm" />
					<div className="min-w-0 flex-1 space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<Skeleton className="h-4 w-20 rounded-full" />
							<Skeleton className="h-3 w-12" />
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-3 w-28" />
						</div>
					</div>
					<Skeleton className="h-8 w-24 shrink-0 rounded-md" />
				</div>
			</div>

			{/* Log column — line number, timestamp, message, at decreasing fill. */}
			<div className="flex-1 space-y-1.5 overflow-hidden bg-muted/20 p-6">
				{["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/6", "w-3/5", "w-2/5", "w-3/4"].map(
					(w, i) => (
						<div key={i} className="flex gap-4">
							<Skeleton className="h-3 w-8 shrink-0" />
							<Skeleton className="h-3 w-[85px] shrink-0" />
							<Skeleton className={`h-3 ${w}`} />
						</div>
					),
				)}
			</div>
		</div>
	);
}
