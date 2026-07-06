// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton for the Ask-AI page: a conversation column + docked composer. */
export default function SupportAskLoading() {
	return (
		<div className="flex h-[calc(100vh-3.5rem)] -m-4 flex-col gap-4 p-6 sm:-m-6 lg:-m-8 xl:-m-10">
			<Skeleton className="h-16 w-3/4 rounded-lg" />
			<Skeleton className="h-24 w-2/3 self-end rounded-lg" />
			<Skeleton className="h-20 w-3/4 rounded-lg" />
			<div className="mt-auto">
				<Skeleton className="h-12 w-full rounded-lg" />
			</div>
		</div>
	);
}
