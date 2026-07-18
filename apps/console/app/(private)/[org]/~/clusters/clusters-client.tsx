"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { ClusterCard } from "@/components/clusters/cluster-card";
import { ErrorState } from "@/components/errors/error-state";
import { useClustersQuery } from "@/lib/query/use-clusters-query";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { Server } from "lucide-react";
import Link from "next/link";

/**
 * Clusters grid. Data comes from the server-prefetched `useClustersQuery` cache, which
 * then polls on the reconciliation cadence; `loading.tsx` covers the prefetch window. Pass
 * `projectId` to scope the grid to a single project (each row's `id` is its project id) — the
 * project drilldown's Clusters page reuses this with the shared org cache.
 */
export function ClustersClient({ projectId }: { projectId?: string }) {
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

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Clusters
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Provisioned infrastructure and access credentials.
				</p>
			</div>

			{isError ? (
				// A fetch failure must not render as "no clusters provisioned".
				<ErrorState
					title="Couldn't load clusters"
					description="Something went wrong fetching your clusters. Check your connection and try again."
					actions={
						<Button variant="outline" size="sm" onClick={() => refetch()}>
							Retry
						</Button>
					}
				/>
			) : clusters.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No clusters provisioned
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Clusters appear here after you deploy a project. Go to a
						project&apos;s detail page and click Deploy.
					</p>
					<Link
						href="/dashboard/new"
						className="mt-4 text-xs text-primary hover:underline"
					>
						Create a project
					</Link>
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
			)}
		</div>
	);
}
