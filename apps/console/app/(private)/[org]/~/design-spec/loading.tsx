// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

export default function DesignSpecLoading() {
	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-4 w-96" />
			</div>

			<div className="flex gap-2">
				{[1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-10 w-28 rounded-lg" />
				))}
			</div>

			<div className="space-y-8">
				{[1, 2, 3, 4].map((section) => (
					<div key={section} className="rounded-lg border border-border/40 p-6 space-y-4">
						<div className="space-y-1">
							<Skeleton className="h-5 w-36" />
							<Skeleton className="h-3 w-64" />
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							{[1, 2, 3, 4].map((field) => (
								<div key={field} className="space-y-2">
									<Skeleton className="h-3 w-24" />
									<Skeleton className="h-9 w-full rounded-md" />
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
