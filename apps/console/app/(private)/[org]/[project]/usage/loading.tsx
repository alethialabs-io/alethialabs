// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the Usage view — a header, a stat row, and a chart block. */
export default function UsageLoading() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-6 w-32" />
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-24 rounded-lg" />
				))}
			</div>
			<Skeleton className="h-64 w-full rounded-lg" />
		</div>
	);
}
