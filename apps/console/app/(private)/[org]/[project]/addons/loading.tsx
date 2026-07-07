// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the Add-ons route prefetches the catalog + install state. */
export default function AddonsLoading() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-8 w-48 rounded-md" />
			<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-40 w-full rounded-lg" />
				))}
			</div>
		</div>
	);
}
