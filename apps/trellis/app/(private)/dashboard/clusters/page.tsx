"use client";

import { ClusterCard } from "@/components/clusters/cluster-card";
import { useClustersStore } from "@/lib/stores/use-clusters-store";
import { createClient } from "@/lib/supabase/client";
import { Server } from "lucide-react";
import { useEffect } from "react";

export default function ClustersPage() {
	const { clusters, isLoading, fetchClusters } = useClustersStore();

	useEffect(() => {
		fetchClusters();
	}, [fetchClusters]);

	useEffect(() => {
		const supabase = createClient();
		const channel = supabase
			.channel("clusters-realtime")
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: "vines",
				},
				(payload) => {
					if ((payload.new as { status: string }).status === "ACTIVE") {
						fetchClusters();
					}
				},
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
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
						<div
							key={i}
							className="h-48 rounded-lg bg-muted animate-pulse"
						/>
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
						Clusters appear here after you apply a plan. Go to a
						vine&apos;s Plan + Cost tab and click Apply
						Infrastructure.
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
					{clusters.map((cluster) => (
						<ClusterCard
							key={cluster.vine_id}
							cluster={cluster}
						/>
					))}
				</div>
			)}
		</div>
	);
}
