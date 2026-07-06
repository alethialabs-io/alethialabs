// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the clusters route prefetches on the server. */
export default function ClustersLoading() {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Clusters
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Provisioned infrastructure and access credentials.
				</p>
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{[1, 2].map((i) => (
					<div key={i} className="rounded-lg border border-border/40 p-5 space-y-4">
						<div className="flex items-center justify-between">
							<Skeleton className="h-5 w-32" />
							<Skeleton className="h-5 w-16 rounded-full" />
						</div>
						<div className="space-y-2">
							<Skeleton className="h-3 w-48" />
							<Skeleton className="h-3 w-36" />
						</div>
						<div className="flex gap-2 pt-2">
							<Skeleton className="h-7 w-20 rounded-md" />
							<Skeleton className="h-7 w-24 rounded-md" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
