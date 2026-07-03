// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton for the agent route: thread list rail + conversation column. */
export default function AgentLoading() {
	return (
		<div className="flex h-[calc(100vh-3.5rem)] -m-4 sm:-m-6 lg:-m-8 xl:-m-10">
			<div className="hidden w-64 shrink-0 space-y-2 border-r p-3 md:block">
				{Array.from({ length: 6 }, (_, i) => (
					<Skeleton key={i} className="h-10 w-full rounded-md" />
				))}
			</div>
			<div className="flex flex-1 flex-col gap-4 p-6">
				<Skeleton className="h-16 w-3/4 rounded-lg" />
				<Skeleton className="h-24 w-2/3 self-end rounded-lg" />
				<Skeleton className="h-20 w-3/4 rounded-lg" />
				<div className="mt-auto">
					<Skeleton className="h-12 w-full rounded-lg" />
				</div>
			</div>
		</div>
	);
}
