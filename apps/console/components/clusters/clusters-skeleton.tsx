"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A CLIENT component, and both clusters routes' `loading.tsx` (server components) render it with one
// boolean prop, which is all that crosses the boundary. It has to be one: it renders the list's real
// filter bar, whose controls take handlers.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { clusterColumnCount } from "@/components/clusters/cluster-columns";
import { ClustersFilterBar } from "@/components/clusters/clusters-filter-bar";
import { DEFAULT_CLUSTER_FILTERS } from "@/components/clusters/clusters-query";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/** The min-height a full-region state of the clusters page takes: its refusal, error and empty state. */
export const CLUSTERS_REGION = "min-h-[60vh]";

/** A handler for a control nobody can reach: the skeleton is inert. */
function ignore() {}

/**
 * The loading form of the clusters list (`ClustersClient`), in the order and the boxes it renders:
 * the toolbar (a count and one line of description), the list's OWN filter bar at its defaults —
 * not bars of guessed widths, because where the bar wraps is decided by its controls' real widths —
 * and the table with the route's column count.
 *
 * Synchronous: it reads nothing, so it is the first thing the route paints (the skeleton rules,
 * docs/ui-conformance/RUBRIC.md). `showProject` is false on a project's own Clusters page, which
 * has no Project column.
 */
export function ClustersSkeleton({ showProject = true }: { showProject?: boolean }) {
	return (
		<SkeletonRoot className="space-y-6" data-skeleton="clusters" inert>
			<PageToolbarSkeleton />
			<ClustersFilterBar
				className="animate-pulse"
				filters={DEFAULT_CLUSTER_FILTERS}
				onFilter={ignore}
				onReset={ignore}
				facets={undefined}
			/>
			<DataTableSkeleton columns={clusterColumnCount(showProject)} rows={4} />
		</SkeletonRoot>
	);
}
