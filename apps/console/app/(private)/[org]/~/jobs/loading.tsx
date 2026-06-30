// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the jobs route prefetches on the server. */
export default function JobsLoading() {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">Jobs</h1>
				<p className="text-sm text-muted-foreground mt-1">Provision job history and execution logs.</p>
			</div>
			<div className="space-y-4">
				<div className="flex flex-col sm:flex-row gap-3">
					<div className="flex gap-1">
						{[1, 2, 3, 4, 5].map((i) => (
							<Skeleton key={i} className="h-7 w-16 rounded-md" />
						))}
					</div>
					<Skeleton className="h-7 w-48 rounded-md" />
				</div>
				<div className="rounded-lg border border-border/40">
					<div className="flex gap-4 border-b border-border/40 p-3">
						{[1, 2, 3, 4, 5].map((i) => (
							<Skeleton key={i} className="h-3 w-20" />
						))}
					</div>
					{[1, 2, 3, 4, 5].map((i) => (
						<div key={i} className="flex gap-4 border-b border-border/20 p-3">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-3 w-20" />
							<Skeleton className="h-3 w-14 rounded-full" />
							<Skeleton className="h-3 w-24" />
							<Skeleton className="h-3 w-28" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
