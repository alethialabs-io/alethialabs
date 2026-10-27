// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * The Environments page while its read is in flight — the route's `loading.tsx` and the view's own
 * pending branch render THIS one component, so the two cannot drift apart (RUBRIC B2).
 *
 * It has the final layout's shape: the toolbar row (count, one line of description, and the page's
 * two actions — New Environment and Promote, which the page renders at every environment count), a stage label, and environment cards built like `EnvironmentCard` — the
 * identity line, the meta line, the classification row, the "gates into this env" block, and the
 * right rail on wide screens. It promises nothing the page may not render: no promotion panel
 * (most projects have none in flight) and no matrix or history (they render only with data).
 */
export function EnvironmentsSkeleton() {
	return (
		<div className="space-y-8" aria-busy>
			<PageToolbarSkeleton count actions={2} />
			<section className="space-y-4">
				<div className="space-y-2.5">
					<Skeleton className="h-3 w-24" />
					{[0, 1].map((i) => (
						<div
							key={i}
							className="grid grid-cols-1 gap-4 rounded-lg border bg-surface p-4 shadow-sm sm:grid-cols-[1fr_auto]"
						>
							<div className="min-w-0 space-y-2.5">
								<div className="flex items-center gap-2.5">
									<Skeleton className="h-5 w-32" />
									<Skeleton className="h-4 w-12" />
								</div>
								<Skeleton className="h-4 w-48" />
								<Skeleton className="h-6 w-40" />
								<div className="space-y-2 border-t border-border-faint pt-3">
									<Skeleton className="h-3 w-28" />
									<div className="flex gap-1.5">
										<Skeleton className="h-5 w-20" />
										<Skeleton className="h-5 w-14" />
										<Skeleton className="h-5 w-20" />
									</div>
								</div>
							</div>
							<div className="flex min-w-[148px] flex-col items-end justify-between gap-3 border-t border-border-faint pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
								<div className="w-full space-y-1.5">
									<Skeleton className="h-3 w-16" />
									<Skeleton className="h-5 w-9 rounded-full" />
								</div>
								<Skeleton className="size-8" />
							</div>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
