"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClusterCard } from "@/components/clusters/cluster-card";
import { useClustersQuery } from "@/lib/query/use-clusters-query";
import { Server } from "lucide-react";
import Link from "next/link";

/**
 * Clusters grid. Data comes from the server-prefetched `useClustersQuery` cache, which
 * then polls on the reconciliation cadence; `loading.tsx` covers the prefetch window.
 */
export function ClustersClient() {
	const { data: clusters = [] } = useClustersQuery();

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
					{clusters.map((cluster) => (
						<ClusterCard key={cluster.id} data={cluster} />
					))}
				</div>
			)}
		</div>
	);
}
