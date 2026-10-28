// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the roles route's `loading.tsx` renders this, and it is a server component.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * The loading form of the Roles page (`RolesManager`), in its boxes (#6129, B2): the toolbar
 * (count, one line, Create role), the filter bar (search, Kind), then the master/detail — the
 * 260px rail with its Built-in heading and four rows, and the detail panel's header and matrix.
 */
export function RolesSkeleton() {
	return (
		<div aria-busy>
			<PageToolbarSkeleton className="mb-4" count actions={1} />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<div aria-hidden className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
				<div className="space-y-1 rounded-lg border border-border bg-surface p-2 shadow-sm">
					<Skeleton className="mx-2.5 my-2 h-3 w-16" />
					{Array.from({ length: 4 }, (_, i) => (
						<Skeleton key={i} className="h-9 w-full rounded-sm" />
					))}
				</div>
				<div className="rounded-lg border border-border bg-surface shadow-sm">
					<div className="space-y-2 border-b border-border px-5 py-4">
						<Skeleton className="h-5 w-40" />
						<Skeleton className="h-3 w-64" />
					</div>
					<div className="space-y-2 px-5 py-4">
						{Array.from({ length: 6 }, (_, i) => (
							<Skeleton key={i} className="h-8 w-full" />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
