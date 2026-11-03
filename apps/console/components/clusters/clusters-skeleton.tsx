// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * The height the clusters region fills before it has cards: the empty state, the refusal and the
 * skeleton all take it, so the skeleton and the render that replaces it share one outline.
 */
export const CLUSTERS_REGION = "min-h-[60vh]";

/**
 * The clusters region before its read answers. The route's `loading.tsx` and the grid's own pending
 * render share it, so the two cannot disagree (RUBRIC B2).
 *
 * It draws the page every organization has until its first deploy succeeds: the empty state. It is
 * built from the empty state's own parts (`Empty`, `EmptyHeader`, `EmptyMedia`, `EmptyTitle`,
 * `EmptyDescription`, `EmptyContent`) in the same `CLUSTERS_REGION` frame, so it cannot drift from
 * it. Each line is a line box at the rung the real copy uses (`h-[1lh]` under the part's own type
 * size), with a bar inside it: the title, the two lines of the description, and the one action.
 *
 * It used to draw two cluster cards side by side. The skeleton cannot know the count, and on an
 * organization with no clusters those two 288px cards stood where the page puts a centred empty
 * state (#6349, score 0.040 against the 0.02 budget, two columns over none). When clusters exist,
 * the cards replace the placeholder from the top of the region; nothing below it moves.
 *
 * The root's `data-slot` is overridden on purpose: `Empty` stamps `data-slot="empty"`, and a pending
 * region must not read as an empty one (RUBRIC B3).
 */
export function ClustersSkeleton() {
	return (
		<Empty data-slot="clusters-skeleton" aria-busy="true" className={CLUSTERS_REGION}>
			<EmptyHeader className="w-full">
				<EmptyMedia variant="icon">
					<Skeleton className="size-6" />
				</EmptyMedia>
				<EmptyTitle className="flex h-[1lh] w-full items-center justify-center">
					<Skeleton className="h-4 w-56 max-w-full" />
				</EmptyTitle>
				<EmptyDescription className="w-full">
					<div className="flex h-[1lh] items-center justify-center">
						<Skeleton className="h-3 w-full" />
					</div>
					<div className="flex h-[1lh] items-center justify-center">
						<Skeleton className="h-3 w-2/3" />
					</div>
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Skeleton className="h-8 w-32 rounded-none" />
			</EmptyContent>
		</Empty>
	);
}
