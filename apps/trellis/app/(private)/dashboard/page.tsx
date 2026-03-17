"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
	ConfigurationStats,
	DatabaseConfiguration,
} from "@/types/configuration";
import {
	ArrowRight,
	Calendar,
	CheckCircle2,
	Clock,
	Folder,
	History,
	Plus,
	Server,
	Settings,
	TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { hasCloudIdentity } from "./actions";

export default function DashboardPage() {
	const [stats, setStats] = useState<ConfigurationStats | null>(null);
	const [recentConfigs, setRecentConfigs] = useState<DatabaseConfiguration[]>(
		[],
	);
	const [loading, setLoading] = useState(true);
	const router = useRouter();

	useEffect(() => {
		const fetchData = async () => {
			try {
				// Check AWS Identity status
				const hasIdentity = await hasCloudIdentity();

				if (!hasIdentity) {
					const skipped = localStorage.getItem(
						"aws_onboarding_skipped",
					);
					if (!skipped) {
						// Redirect to onboarding if not skipped
						router.push("/onboarding/aws");
						return; // Stop loading data
					}
				}

				// Fetch stats
				const statsRes = await fetch("/api/configurations/stats");
				if (statsRes.ok) {
					const statsData = await statsRes.json();
					setStats(statsData.stats);
				}

				// Fetch recent configurations
				const configsRes = await fetch("/api/configurations?limit=5");
				if (configsRes.ok) {
					const configsData = await configsRes.json();
					setRecentConfigs(configsData.configurations || []);
				}
			} catch (error) {
				console.error("[v0] Error fetching dashboard data:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchData();
	}, [router]);

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	return (
		<div className="space-y-8 w-full">
			{/* Overview Header */}
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Overview
				</h1>
				<p className="text-muted-foreground text-sm">
					Manage your infrastructure configurations and deployments
					across all environments.
				</p>
			</div>

			{/* Stats Cards */}
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<Card className="shadow-sm border-border/40">
					<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
						<CardTitle className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
							Total Configs
						</CardTitle>
						<TrendingUp className="h-4 w-4 text-muted-foreground opacity-60" />
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-8 w-16" />
						) : (
							<div className="text-3xl font-bold tracking-tight">
								{stats?.total || 0}
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="shadow-sm border-border/40">
					<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
						<CardTitle className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
							Completed
						</CardTitle>
						<CheckCircle2 className="h-4 w-4 text-muted-foreground opacity-60" />
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-8 w-16" />
						) : (
							<div className="text-3xl font-bold tracking-tight">
								{stats?.completed || 0}
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="shadow-sm border-border/40">
					<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
						<CardTitle className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
							In Progress
						</CardTitle>
						<Clock className="h-4 w-4 text-muted-foreground opacity-60" />
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-8 w-16" />
						) : (
							<div className="text-3xl font-bold tracking-tight">
								{stats?.draft || 0}
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="shadow-sm border-border/40">
					<CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
						<CardTitle className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
							Recent
						</CardTitle>
						<Calendar className="h-4 w-4 text-muted-foreground opacity-60" />
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-8 w-16" />
						) : (
							<div className="text-3xl font-bold tracking-tight">
								{stats?.recentCount || 0}
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 lg:grid-cols-7">
				{/* Recent Configurations */}
				<Card className="shadow-sm lg:col-span-4 xl:col-span-5 border-border/40">
					<CardHeader className="flex flex-row items-center justify-between border-b border-border/40 pb-4 bg-muted/20">
						<div className="space-y-1">
							<CardTitle className="text-base font-medium">
								Recent Configurations
							</CardTitle>
							<CardDescription className="text-xs">
								Your latest infrastructure setups.
							</CardDescription>
						</div>
						<Link href="/dashboard/configurations">
							<Button
								variant="ghost"
								size="sm"
								className="text-xs h-8 text-muted-foreground hover:text-foreground"
							>
								View All
							</Button>
						</Link>
					</CardHeader>
					<CardContent className="p-0">
						{loading ? (
							<div className="space-y-0 divide-y divide-border/40">
								{[1, 2, 3].map((i) => (
									<div
										key={i}
										className="flex items-center justify-between p-4"
									>
										<div className="flex items-center gap-4">
											<Skeleton className="h-9 w-9 rounded-md" />
											<div className="space-y-2">
												<Skeleton className="h-4 w-[150px]" />
												<Skeleton className="h-3 w-[100px]" />
											</div>
										</div>
										<Skeleton className="h-5 w-16 rounded-full" />
									</div>
								))}
							</div>
						) : recentConfigs.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-16 text-center">
								<Settings className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
								<h3 className="font-medium text-foreground text-sm mb-1">
									No configurations found
								</h3>
								<p className="text-xs text-muted-foreground mb-6 max-w-sm">
									Get started by creating your first
									infrastructure configuration.
								</p>
								<Link href="/dashboard/configure">
									<Button
										size="sm"
										className="h-8 text-xs font-medium"
									>
										<Plus className="mr-2 h-3.5 w-3.5" />
										Create Configuration
									</Button>
								</Link>
							</div>
						) : (
							<div className="space-y-0 divide-y divide-border/40">
								{recentConfigs.map((config) => (
									<Link
										key={config.id}
										href={`/dashboard/configurations/${config.id}`}
										className="flex items-center justify-between group p-4 hover:bg-muted/30 transition-colors"
									>
										<div className="flex items-center gap-4">
											<div className="flex h-9 w-9 items-center justify-center rounded-md border border-border/50 bg-background group-hover:border-border transition-colors shrink-0">
												<Folder className="h-4 w-4 text-muted-foreground" />
											</div>
											<div className="space-y-1.5 min-w-0">
												<p className="text-sm font-medium leading-none text-foreground group-hover:underline truncate">
													{config.name}
												</p>
												<p className="text-[11px] text-muted-foreground truncate">
													{config.project_name} •{" "}
													{config.environment_stage} •{" "}
													{formatDate(
														config.created_at,
													)}
												</p>
											</div>
										</div>
										<Badge
											variant="outline"
											className={cn(
												"font-medium text-[10px] uppercase px-2.5 py-0.5 h-5 border-border/50 ml-4 shrink-0",
												config.status === "completed"
													? "text-foreground bg-foreground/5 border-foreground/10"
													: "text-muted-foreground bg-muted/30",
											)}
										>
											{config.status}
										</Badge>
									</Link>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Quick Actions & Navigation */}
				<div className="space-y-6 lg:col-span-3 xl:col-span-2">
					<Card className="shadow-sm border-border/40">
						<CardHeader className="bg-muted/20 border-b border-border/40 pb-4">
							<CardTitle className="text-base font-medium">
								Quick Actions
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2 pt-5">
							<Link href="/dashboard/configure" className="block">
								<Button
									className="w-full justify-start text-sm h-9 font-medium"
									variant="default"
								>
									<Plus className="mr-2 h-4 w-4" />
									Create Configuration
								</Button>
							</Link>
							<Link href="/dashboard/clusters" className="block">
								<Button
									className="w-full justify-start text-sm h-9 font-medium text-muted-foreground hover:text-foreground"
									variant="outline"
								>
									<Server className="mr-2 h-4 w-4 opacity-70" />
									Manage Clusters
								</Button>
							</Link>
							<Link href="/dashboard/history" className="block">
								<Button
									className="w-full justify-start text-sm h-9 font-medium text-muted-foreground hover:text-foreground"
									variant="outline"
								>
									<History className="mr-2 h-4 w-4 opacity-70" />
									Deployment History
								</Button>
							</Link>
						</CardContent>
					</Card>

					<Card className="shadow-sm border-border/40 bg-muted/10">
						<CardContent className="pt-6 pb-6">
							<div className="flex flex-col items-center text-center space-y-4">
								<div className="h-12 w-12 rounded-xl bg-background border border-border/60 flex items-center justify-center shadow-sm">
									<img
										src="/itgix-favicon-32x32.png"
										alt="Trellis"
										className="h-6 w-6 grayscale opacity-60"
									/>
								</div>
								<div className="space-y-1.5">
									<h4 className="text-sm font-medium text-foreground">
										Grape CLI
									</h4>
									<p className="text-xs text-muted-foreground px-4 leading-relaxed">
										Use our command-line tool to manage
										infrastructure directly from your
										terminal.
									</p>
								</div>
								<Link href="/installation">
									<Button
										variant="link"
										size="sm"
										className="text-xs h-8 text-muted-foreground hover:text-foreground"
									>
										View installation guide
										<ArrowRight className="ml-1 h-3 w-3" />
									</Button>
								</Link>
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
