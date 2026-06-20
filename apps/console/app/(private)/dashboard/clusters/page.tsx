"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { ClusterCard } from "@/components/clusters/cluster-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useClustersStore } from "@/lib/stores/use-clusters-store";
import { Server } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

// Interim reconciliation cadence; an SSE stream (Postgres LISTEN/NOTIFY) will replace this poll.
const CLUSTERS_POLL_INTERVAL_MS = 5000;

export default function ClustersPage() {
	const { clusters, isLoading, fetchClusters } = useClustersStore();

	useEffect(() => {
		fetchClusters();
	}, [fetchClusters]);

	useEffect(() => {
		const interval = setInterval(() => {
			fetchClusters(true);
		}, CLUSTERS_POLL_INTERVAL_MS);

		return () => {
			clearInterval(interval);
		};
	}, [fetchClusters]);

	if (isLoading) {
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
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
					{[1, 2].map((i) => (
						<div key={i} className="rounded-lg border border-border/40 p-5 space-y-4">
							<div className="flex items-center justify-between">
								<Skeleton className="h-5 w-32" />
								<Skeleton className="h-5 w-16 rounded-full" />
							</div>
							<div className="space-y-2">
								<Skeleton className="h-3 w-48" />
								<Skeleton className="h-3 w-36" />
							</div>
							<div className="flex gap-2 pt-2">
								<Skeleton className="h-7 w-20 rounded-md" />
								<Skeleton className="h-7 w-24 rounded-md" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

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

			{clusters.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No clusters provisioned
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Clusters appear here after you deploy a spec. Go to a
						spec&apos;s detail page and click Deploy.
					</p>
					<Link
						href="/dashboard/design-spec"
						className="mt-4 text-xs text-primary hover:underline"
					>
						Create a spec
					</Link>
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
					{clusters.map((cluster) => (
						<ClusterCard
							key={cluster.id}
							data={cluster}
						/>
					))}
				</div>
			)}
		</div>
	);
}
