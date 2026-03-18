"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { PublicClustersRow } from "@/lib/validations/db.schemas";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Server, Activity, Clock, Globe, Shield, Terminal } from "lucide-react";
import Link from "next/link";
import { LogViewer } from "./log-viewer";

interface ClusterListProps {
	initialClusters: PublicClustersRow[];
	userId: string;
}

export function ClusterList({ initialClusters, userId }: ClusterListProps) {
	const [clusters, setClusters] = useState<PublicClustersRow[]>(initialClusters);
	const [selectedCluster, setSelectedCluster] = useState<PublicClustersRow | null>(null);
	const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
	const supabase = createClient();

	useEffect(() => {
		const channel = supabase
			.channel("realtime:clusters")
			.on(
				"postgres_changes",
				{
					event: "*",
					schema: "public",
					table: "clusters",
					filter: `user_id=eq.${userId}`,
				},
				(payload) => {
					console.log("Change received!", payload);
					if (payload.eventType === "INSERT") {
						setClusters((prev) => [payload.new as PublicClustersRow, ...prev]);
					} else if (payload.eventType === "UPDATE") {
						setClusters((prev) =>
							prev.map((c) =>
								c.id === payload.new.id ? (payload.new as PublicClustersRow) : c
							)
						);
					} else if (payload.eventType === "DELETE") {
						setClusters((prev) => prev.filter((c) => c.id !== payload.old.id));
					}
				}
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [supabase, userId]);

	const getStatusColor = (status: string) => {
		switch (status) {
			case "ONLINE":
				return "bg-emerald-50 text-emerald-700 border-emerald-200";
			case "OFFLINE":
				return "bg-destructive/10 text-destructive border-destructive/20";
			default:
				return "bg-muted text-muted-foreground border-border/50";
		}
	};

	if (!clusters || clusters.length === 0) {
		return (
			<Card className="border-border/40 shadow-sm bg-muted/10">
				<CardContent className="flex flex-col items-center justify-center py-20 text-center">
					<div className="w-16 h-16 bg-background border border-border/50 rounded-xl flex items-center justify-center mx-auto mb-6 shadow-sm">
						<Server className="h-8 w-8 text-muted-foreground opacity-50" />
					</div>
					<h3 className="text-xl font-semibold text-foreground mb-2 tracking-tight">
						No Clusters Connected
					</h3>
					<p className="text-muted-foreground mb-8 max-w-md mx-auto text-sm leading-relaxed">
						Start by bootstrapping your first environment using the Grape CLI. It only takes a few minutes.
					</p>
					
					<div className="relative max-w-md mx-auto mb-10 w-full sm:w-[400px]">
						<div className="bg-foreground text-background p-4 rounded-lg font-mono text-sm shadow-md flex items-center justify-between">
							<span className="opacity-90">$ grape bootstrap</span>
							<Terminal className="h-4 w-4 opacity-50" />
						</div>
					</div>

					<Link href="https://docs.itgix.com/setup/cli" target="_blank">
						<Button className="h-10 px-6 font-medium text-sm">
							Get Started with CLI
							<ArrowRight className="ml-2 h-4 w-4" />
						</Button>
					</Link>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{clusters.map((cluster: PublicClustersRow) => {
				const metadata = cluster.metadata as any;
				return (
					<Card
						key={cluster.id}
						className="group flex flex-col justify-between overflow-hidden border-border/40 bg-background shadow-sm hover:border-border transition-colors"
					>
						<CardHeader className="pb-4">
							<div className="flex items-center justify-between mb-3">
								<div className="p-2 border border-border/50 bg-muted/20 rounded-md">
									<Server className="h-4 w-4 text-foreground" />
								</div>
								<Badge
									variant="outline"
									className={cn(
										"font-medium px-2 py-0.5 rounded-full text-[10px] tracking-wider uppercase border",
										getStatusColor(cluster.status || 'PENDING')
									)}
								>
									<span className={cn(
										"w-1.5 h-1.5 rounded-full mr-1.5",
										cluster.status === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 
										cluster.status === 'OFFLINE' ? 'bg-destructive' : 'bg-muted-foreground'
									)} />
									{cluster.status}
								</Badge>
							</div>
							<CardTitle className="text-base font-semibold text-foreground truncate">
								{cluster.name}
							</CardTitle>
							<CardDescription className="font-mono text-[11px] text-muted-foreground truncate">
								{cluster.id}
							</CardDescription>
						</CardHeader>

						<CardContent className="space-y-5 pb-4">
							<div className="grid grid-cols-2 gap-4">
								<div className="space-y-1.5">
									<p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Region</p>
									<div className="flex items-center gap-2 text-foreground">
										<Globe className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="text-sm font-medium">{metadata?.region || "N/A"}</span>
									</div>
								</div>
								<div className="space-y-1.5">
									<p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Network</p>
									<div className="flex items-center gap-2 text-foreground">
										<Shield className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="text-sm font-medium">{metadata?.vpc_cidr || "N/A"}</span>
									</div>
								</div>
							</div>

							<div className="pt-4 border-t border-border/40 space-y-3">
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Activity className="h-3.5 w-3.5" />
										<span className="text-[13px]">Pulse</span>
									</div>
									<span className="font-medium text-[13px] text-foreground">
										{cluster.last_heartbeat
											? formatDistanceToNow(new Date(cluster.last_heartbeat), { addSuffix: true })
											: "No signal yet"}
									</span>
								</div>
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Clock className="h-3.5 w-3.5" />
										<span className="text-[13px]">Bootstrapped</span>
									</div>
									<span className="font-medium text-[13px] text-foreground">
										{cluster.created_at ? new Date(cluster.created_at).toLocaleDateString(undefined, { 
											year: 'numeric', 
											month: 'short', 
											day: 'numeric' 
										}) : "Unknown"}
									</span>
								</div>
							</div>
						</CardContent>

						<CardFooter className="bg-muted/10 border-t border-border/20 p-4 flex justify-between items-center">
							<p className="text-[11px] text-muted-foreground truncate max-w-[120px]" title={metadata?.vpc_id || "Provisioned"}>
								{metadata?.vpc_id || "Provisioned"}
							</p>
							<div className="flex gap-2">
								<Button 
									size="sm" 
									variant="outline" 
									className="h-8 text-xs font-medium border-border/50"
									onClick={() => {
										setSelectedCluster(cluster);
										setIsLogViewerOpen(true);
									}}
								>
									<Terminal className="h-3.5 w-3.5 mr-1.5 opacity-70" />
									Logs
								</Button>
								<Button size="sm" variant="secondary" className="h-8 text-xs font-medium">
									Details
								</Button>
							</div>
						</CardFooter>
					</Card>
				);
			})}
			<LogViewer 
				clusterId={selectedCluster?.id || null} 
				clusterName={selectedCluster?.name}
				open={isLogViewerOpen} 
				onOpenChange={setIsLogViewerOpen} 
			/>
		</div>
	);
}