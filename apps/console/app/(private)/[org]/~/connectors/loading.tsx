// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@/components/ui/skeleton";

export default function ConnectorsLoading() {
	return (
		<div className="space-y-8">
			<div>
				<Skeleton className="h-7 w-32" />
				<Skeleton className="h-4 w-80 mt-1" />
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				<div className="space-y-4">
					<Skeleton className="h-4 w-24" />
					{[1, 2, 3].map((i) => (
						<div key={i} className="rounded-lg border border-border/40 p-4 space-y-3">
							<div className="flex items-center gap-3">
								<Skeleton className="h-8 w-8 rounded-md" />
								<div className="flex-1 space-y-1">
									<Skeleton className="h-4 w-20" />
									<Skeleton className="h-3 w-40" />
								</div>
								<Skeleton className="h-5 w-16 rounded-full" />
							</div>
						</div>
					))}
				</div>

				<div className="space-y-4">
					<Skeleton className="h-4 w-32" />
					{[1, 2, 3].map((i) => (
						<div key={i} className="rounded-lg border border-border/40 p-4 space-y-3">
							<div className="flex items-center gap-3">
								<Skeleton className="h-8 w-8 rounded-md" />
								<div className="flex-1 space-y-1">
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-3 w-48" />
								</div>
								<Skeleton className="h-7 w-20 rounded-md" />
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
