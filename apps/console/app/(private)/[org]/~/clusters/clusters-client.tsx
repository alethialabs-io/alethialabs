"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { ClusterCard } from "@/components/clusters/cluster-card";
import { ErrorState } from "@/components/errors/error-state";
import { useClustersQuery } from "@/lib/query/use-clusters-query";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Server } from "lucide-react";
import Link from "next/link";

/**
 * Clusters grid. Data comes from the server-prefetched `useClustersQuery` cache, which
 * then polls on the reconciliation cadence; `loading.tsx` covers the prefetch window. Pass
 * `projectId` to scope the grid to a single project (each row's `id` is its project id) — the
 * project drilldown's Clusters page reuses this with the shared org cache. No page header:
 * the surface opens straight into content, like evidence / jobs / runners.
 */
export function ClustersClient({ projectId }: { projectId?: string }) {
	const orgSlug = useActiveOrgSlug();
	const { data: allClusters = [], isError, refetch } = useClustersQuery();
	const clusters = projectId
		? allClusters.filter((c) => c.id === projectId)
		: allClusters;
	// One batched query hydrates every cluster card's classification chips (keyed on the
	// project_cluster row id, the classifiable resource).
	const clusterIds = clusters
		.map((c) =>
			Array.isArray(c.project_cluster)
				? c.project_cluster[0]?.id
				: c.project_cluster?.id,
		)
		.filter((id): id is string => Boolean(id));
	const { data: classMap = {} } = useAssignmentsForKind(
		"project_cluster",
		clusterIds,
	);

	if (isError) {
		// A fetch failure must not render as "no clusters provisioned".
		return (
			<ErrorState
				title="Couldn't load clusters"
				description="Something went wrong fetching your clusters. Check your connection and try again."
				actions={
					<Button variant="outline" size="sm" onClick={() => refetch()}>
						Retry
					</Button>
				}
			/>
		);
	}

	if (clusters.length === 0) {
		return (
			<Empty className="min-h-[60vh]">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Server />
					</EmptyMedia>
					<EmptyTitle>No clusters provisioned</EmptyTitle>
					<EmptyDescription>
						Clusters appear here once a project deploys its first environment. Open a
						project and deploy to get started.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/new`} />}>
						Browse projects
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			{clusters.map((cluster) => {
				const pc = Array.isArray(cluster.project_cluster)
					? cluster.project_cluster[0]
					: cluster.project_cluster;
				return (
					<ClusterCard
						key={cluster.id}
						data={cluster}
						initialAssignments={pc?.id ? classMap[pc.id] : undefined}
					/>
				);
			})}
		</div>
	);
}
