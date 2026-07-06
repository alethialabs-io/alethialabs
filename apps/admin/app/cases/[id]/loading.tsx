// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the staff case-detail route while the server prefetch resolves. */
export default function SupportAdminCaseLoading() {
	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
			<Skeleton className="h-7 w-24" />
			<div className="space-y-3">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-6 w-96" />
				<div className="flex gap-2">
					<Skeleton className="h-5 w-16" />
					<Skeleton className="h-5 w-16" />
					<Skeleton className="h-5 w-40" />
				</div>
			</div>
			<div className="space-y-4 rounded-md border p-4">
				<Skeleton className="h-16 w-2/3" />
				<Skeleton className="ml-auto h-16 w-2/3" />
				<Skeleton className="h-16 w-2/3" />
			</div>
			<Skeleton className="h-24 w-full" />
		</div>
	);
}
