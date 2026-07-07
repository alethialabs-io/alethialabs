// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the Evidence route prefetches the roll-up on the server. */
export default function EvidenceLoading() {
	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<Skeleton key={i} className="h-[72px] w-full rounded-lg" />
				))}
			</div>
			<Skeleton className="h-9 w-64 rounded-md" />
			<Skeleton className="h-64 w-full rounded-lg" />
		</div>
	);
}
