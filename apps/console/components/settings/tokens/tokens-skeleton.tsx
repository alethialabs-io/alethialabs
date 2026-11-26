// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/** The service tokens route's instant skeleton: the one toolbar row (search, Status, Create token) and three table rows. */
export function TokensSkeleton() {
	return (
		<div className="space-y-6" aria-busy="true" aria-label="Loading service tokens">
			<ListToolbarSkeleton facets={1} actions={1} />
			<div className="rounded-sm border border-border">
				{[0, 1, 2].map((row) => (
					<div key={row} className="flex gap-6 border-b border-border px-3 py-3.5 last:border-b-0">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-4 w-36" />
						<Skeleton className="h-4 w-1/5" />
					</div>
				))}
			</div>
		</div>
	);
}
