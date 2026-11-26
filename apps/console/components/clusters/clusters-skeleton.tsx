"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Both clusters routes' `loading.tsx` (server components) render it with one boolean prop, which is
// all that crosses the boundary.

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { clusterColumnCount } from "@/components/clusters/cluster-columns";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/** The min-height a full-region state of the clusters page takes: its refusal, error and empty state. */
export const CLUSTERS_REGION = "min-h-[60vh]";

/**
 * The loading form of the clusters list (`ClustersClient`), in the order and the boxes it renders:
 * the one-row `ListToolbar` (a search and the three facets: Cloud, Status, Region) and the table with
 * the route's column count.
 *
 * Synchronous: it reads nothing, so it is the first thing the route paints (the skeleton rules,
 * docs/ui-conformance/RUBRIC.md). `showProject` is false on a project's own Clusters page, which
 * has no Project column.
 */
export function ClustersSkeleton({ showProject = true }: { showProject?: boolean }) {
	return (
		<SkeletonRoot className="space-y-6" data-skeleton="clusters" inert>
			<ListToolbarSkeleton facets={3} />
			<DataTableSkeleton columns={clusterColumnCount(showProject)} rows={4} />
		</SkeletonRoot>
	);
}
