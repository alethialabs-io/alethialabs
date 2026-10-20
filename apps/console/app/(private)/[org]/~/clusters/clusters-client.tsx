"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Lock, Server } from "lucide-react";
import Link from "next/link";
import { ClusterCard } from "@/components/clusters/cluster-card";
import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";
import { RegionError } from "@/components/errors/region-error";
import { isForbidden } from "@/components/overview/overview-reads";
import { useClustersQuery } from "@/lib/query/use-clusters-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/**
 * Clusters grid: one card per cluster under management (lib/queries/usage-counts.ts — the same
 * definition the Usage page counts), pending and failed ones included, each rendered as such.
 *
 * The data is the server-prefetched `clusters.list` read, kept current by the change stream — no
 * poll. Pass `projectId` to scope the grid to one project's clusters (each row's `id` is its
 * project's id); the project drilldown's Clusters page reuses this over the same org-wide cache.
 *
 * Five distinct renders, so nothing reads as something it is not (RUBRIC B3/B4): pending is the
 * skeleton, a refusal says the viewer lacks access, a failure says it failed and offers a retry, no
 * clusters is the empty state, and clusters are the grid. A refresh that fails after data arrived
 * keeps the cards. No page header: the surface opens straight into content.
 */
export function ClustersClient({ projectId }: { projectId?: string }) {
	const orgSlug = useActiveOrgSlug();
	const clusters = useClustersQuery();

	if (clusters.data === undefined) {
		if (clusters.isError && isForbidden(clusters.error)) {
			// An expected refusal, not a failure: retrying will not change it, so there is no button.
			return (
				<EmptyState
					className="min-h-[60vh]"
					icon={<Lock />}
					title="You don't have access to clusters"
					description="Ask an organization admin for a role that can view projects."
				/>
			);
		}
		if (clusters.isError) {
			return (
				<RegionError
					title="Couldn't load clusters"
					description="Something went wrong fetching your clusters. Check your connection and try again."
					onRetry={() => clusters.refetch()}
				/>
			);
		}
		return <ClustersSkeleton />;
	}

	const rows = projectId ? clusters.data.filter((c) => c.id === projectId) : clusters.data;

	if (rows.length === 0) {
		return (
			<EmptyState
				className="min-h-[60vh]"
				icon={<Server />}
				title={projectId ? "This project has no clusters yet" : "No clusters under management"}
				description="A cluster appears here as soon as its environment is sent to deploy, and stays until it is torn down."
				action={
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={<Link href={projectId ? `/${orgSlug}` : `/${orgSlug}/~/new`} />}
					>
						{projectId ? "Back to projects" : "Browse projects"}
					</Button>
				}
			/>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			{rows.map((cluster) => (
				<ClusterCard key={cluster.project_cluster.id} data={cluster} />
			))}
		</div>
	);
}
