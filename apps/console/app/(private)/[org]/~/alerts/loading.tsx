// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Stacked-section skeleton for the Alerts hub while the bootstrap loads. */
export default function AlertsLoading() {
	return (
		<div className="mx-auto w-full max-w-[1200px] space-y-12">
			{["policies", "channels", "activity"].map((id) => (
				<section key={id} className="space-y-4">
					<div className="flex items-center justify-between">
						<Skeleton className="h-6 w-32" />
						<Skeleton className="h-7 w-16" />
					</div>
					<Skeleton className="h-12 w-full rounded-lg" />
					<div className="flex items-center justify-between">
						<Skeleton className="h-9 w-56" />
						<Skeleton className="h-8 w-28" />
					</div>
					<div className="flex flex-wrap items-start gap-4">
						<Skeleton className="h-64 min-w-[290px] flex-1 rounded-xl" />
						<Skeleton className="h-64 min-w-[min(500px,100%)] flex-[100] rounded-xl" />
					</div>
				</section>
			))}
		</div>
	);
}
