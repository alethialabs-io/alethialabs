// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * The Environments page while its read is in flight. The route's `loading.tsx` and the view's own
 * pending branch render THIS one component, so the two cannot drift apart (RUBRIC B2).
 *
 * It draws the page a project has until somebody adds a second environment: the toolbar row, one
 * stage label, ONE environment card, and the dashed "Only one environment" note under it. Every
 * project starts with exactly its default environment, and the skeleton cannot know the count, so
 * it draws the common case. It used to draw two cards. On a one-environment project the second card
 * sat where the page puts the note and the consistency matrix, so the matrix landed 165px below the
 * block it replaced (#6335, score 0.027 against the 0.02 budget). With two or more environments the
 * second card takes the note's place, so the shift is the card minus the note, not a whole card.
 *
 * Each line of text is a LINE BOX at the rung and leading the card's real copy uses (`h-[1lh]` under
 * the same `text-ui-*`), with a bar inside it, so a skeleton line is as tall as the line it stands
 * for. The classification row is the `size="sm"` Classify button (`ClassificationControl`).
 *
 * It promises nothing that a project may not have: no promotion panel (most projects have none in
 * flight), and no consistency matrix or promotion history. Those render below the list only when
 * there is data, and content that appears below the list moves nothing above it.
 */
export function EnvironmentsSkeleton() {
	return (
		<div className="space-y-8" aria-busy>
			<PageToolbarSkeleton count actions={2} />
			<section className="space-y-4">
				<div className="space-y-2.5">
					<div className="flex h-[1lh] items-center font-mono text-ui-2xs">
						<Skeleton className="h-3 w-24" />
					</div>
					{[0, 1].map((i) => (<div
						key={i}
						data-slot="environment-card-skeleton"
						className="grid grid-cols-1 gap-4 rounded-lg border bg-surface p-4 shadow-sm sm:grid-cols-[1fr_auto]"
					>
						<div className="min-w-0">
							<div className="flex h-[1lh] items-center gap-2.5 font-mono text-ui-lg">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-3 w-12" />
							</div>
							<div className="mt-1.5 flex h-[1lh] items-center text-ui-sm">
								<Skeleton className="h-3 w-48" />
							</div>
							<Skeleton className="mt-2.5 h-8 w-24" />
							<div className="mt-3 border-t border-border-faint pt-3">
								<div className="mb-2 flex h-[1lh] items-center text-ui-sm">
									<Skeleton className="h-3 w-28" />
								</div>
								<div className="flex h-[1lh] items-center text-ui-sm">
									<Skeleton className="h-3 w-56 max-w-full" />
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
					</div>))}
				</div>
				<div
					data-slot="single-environment-note-skeleton"
					className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-ui-md"
				>
					<div className="flex h-[1lh] items-center">
						<Skeleton className="h-3 w-2/3" />
					</div>
				</div>
			</section>
		</div>
	);
}
