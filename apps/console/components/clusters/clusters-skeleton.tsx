// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import {
	CLUSTER_CARD_BLOCK,
	CLUSTER_CARD_FRAME,
	CLUSTER_COMPONENT_ROW,
	CLUSTERS_GRID,
	type ClusterCardShape,
} from "@/components/clusters/cluster-card-shape";

/**
 * The height the clusters region fills when it has no cards: the empty state, the refusal and the
 * empty-frame skeleton all take it, so that skeleton and the render that replaces it share one outline.
 */
export const CLUSTERS_REGION = "min-h-[60vh]";

/**
 * The most card placeholders the skeleton draws. The list is not paginated, and a card is taller
 * than half a viewport, so past the second row of the two-wide grid they are below the fold.
 */
export const MAX_CLUSTER_PLACEHOLDERS = 4;

/**
 * The card a placeholder draws when the cluster list did not answer: the control plane and one data
 * service, an access block with its endpoint and kubeconfig command — the card a deployed cluster has.
 */
const UNKNOWN_CARD: ClusterCardShape = {
	projectId: "",
	components: 2,
	access: { codeRows: 2, captions: 0, download: false },
	argocd: false,
	dns: false,
};

/** Placeholders drawn when the cluster list did not answer: two, side by side on a wide screen. */
const UNKNOWN_CARDS: ClusterCardShape[] = [UNKNOWN_CARD, UNKNOWN_CARD];

/**
 * The clusters region before its read answers (RUBRIC B2). It draws what the viewer is about to get,
 * decided by `shapes` — the cluster list's answer, read by the route's `loading.tsx` through the
 * request's query client (`readClusterShapes`):
 *
 * - `[]` — no clusters: the empty state's frame (`ClustersEmptySkeleton`). An organization has this
 *   page until its first deploy succeeds.
 * - N shapes — the card grid with min(N, `MAX_CLUSTER_PLACEHOLDERS`) placeholders, each drawn from
 *   its cluster's own `ClusterCardShape`: the card's frame, header, one row per component, and the
 *   access and ArgoCD blocks it has.
 * - `undefined` — the read failed, or nothing has answered yet (the grid's own pending render): the
 *   card grid with two default cards, the common case.
 *
 * It drew the empty frame unconditionally once (#6349): right for an organization with no clusters,
 * and a centred placeholder replaced by a card grid for every organization that has some.
 */
export function ClustersSkeleton({ shapes }: { shapes: ClusterCardShape[] | undefined }) {
	if (shapes !== undefined && shapes.length === 0) return <ClustersEmptySkeleton />;
	const cards = (shapes ?? UNKNOWN_CARDS).slice(0, MAX_CLUSTER_PLACEHOLDERS);
	return (
		<div data-slot="clusters-skeleton" className={CLUSTERS_GRID} aria-busy="true">
			{cards.map((shape, i) => (
				<ClusterCardSkeleton key={i} shape={shape} />
			))}
		</div>
	);
}

/**
 * One `ClusterCard` before it paints, at the card's own frame, padding and rhythm: the header
 * (provider mark, name and posture, the meta line, the chips row, the rollup on the right), one row
 * per component at the row's own box, then the access and ArgoCD blocks the cluster has.
 */
function ClusterCardSkeleton({ shape }: { shape: ClusterCardShape }) {
	return (
		<div data-slot="cluster-card-skeleton" className={CLUSTER_CARD_FRAME}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2.5">
					<Skeleton className="size-5 rounded-sm" />
					<div className="space-y-1.5">
						<div className="flex items-center gap-2">
							<Skeleton className="h-5 w-32" />
							<Skeleton className="h-5 w-16 rounded-full" />
						</div>
						<Skeleton className="h-3 w-48" />
						<Skeleton className="h-5 w-24" />
					</div>
				</div>
				<div className="flex flex-col items-end gap-1">
					<Skeleton className="h-5 w-20 rounded-full" />
					<Skeleton className="h-3 w-16" />
				</div>
			</div>
			<div data-slot="cluster-card-skeleton-components" className="flex flex-col border-t pt-1">
				{Array.from({ length: shape.components }, (_, i) => (
					<div key={i} className={CLUSTER_COMPONENT_ROW}>
						<Skeleton className="h-5 w-full" />
					</div>
				))}
			</div>
			{shape.access && (
				<div data-slot="cluster-card-skeleton-access" className={CLUSTER_CARD_BLOCK}>
					<Skeleton className="h-4 w-28" />
					{Array.from({ length: shape.access.codeRows }, (_, i) => (
						<Skeleton key={`code-${i}`} data-row="code" className="h-6 w-full" />
					))}
					{Array.from({ length: shape.access.captions }, (_, i) => (
						<Skeleton key={`caption-${i}`} data-row="caption" className="h-3 w-2/3" />
					))}
					{shape.access.download && <Skeleton data-row="download" className="h-7 w-44" />}
				</div>
			)}
			{shape.argocd && (
				<div data-slot="cluster-card-skeleton-argocd" className={CLUSTER_CARD_BLOCK}>
					<Skeleton className="h-4 w-20" />
					<Skeleton className="h-6 w-full" />
					<Skeleton className="h-3 w-2/3" />
					<Skeleton className="h-6 w-full" />
				</div>
			)}
		</div>
	);
}

/**
 * The empty state's frame before the read answers — what an organization with no clusters gets. It
 * is built from the empty state's own parts (`Empty`, `EmptyHeader`, `EmptyMedia`, `EmptyTitle`,
 * `EmptyDescription`, `EmptyContent`) in the same `CLUSTERS_REGION` frame, so it cannot drift from
 * it. Each line is a line box at the rung the real copy uses (`h-[1lh]` under the part's own type
 * size), with a bar inside it: the title, the two lines of the description, and the one action.
 *
 * The root's `data-slot` is overridden on purpose: `Empty` stamps `data-slot="empty"`, and a pending
 * region must not read as an empty one (RUBRIC B3).
 */
function ClustersEmptySkeleton() {
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
