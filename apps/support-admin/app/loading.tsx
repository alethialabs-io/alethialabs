// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the staff case-list route while the server prefetch resolves. */
export default function SupportAdminLoading() {
	return (
		<div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
			<div className="flex items-center gap-2">
				<Skeleton className="h-9 w-64" />
				<Skeleton className="h-9 w-40" />
				<Skeleton className="h-9 w-32" />
			</div>
			<div className="overflow-hidden rounded-md border">
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
						key={i}
						className="flex items-center gap-4 border-b border-border/60 px-4 py-3.5 last:border-b-0"
					>
						<Skeleton className="size-2 rounded-full" />
						<div className="flex-1 space-y-2">
							<Skeleton className="h-4 w-72" />
							<Skeleton className="h-3 w-48" />
						</div>
						<Skeleton className="h-5 w-16" />
						<Skeleton className="h-5 w-16" />
					</div>
				))}
			</div>
		</div>
	);
}
