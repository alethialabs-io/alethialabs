"use client";

import {
	getConfigurations,
	GetConfigurationsData,
	getConfigurationStats,
	GetConfigurationStatsData,
} from "@/app/server/actions/configurations";
import { hasCloudIdentity } from "@/app/server/actions/identities";
import { getVineyards, GetVineyardsData } from "@/app/server/actions/vineyards";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { vinesColumns } from "@/components/vines/columns";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRight,
	CheckCircle2,
	Clock,
	FileText,
	Map,
	Plus,
	TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function DashboardPage() {
	const [stats, setStats] = useState<GetConfigurationStatsData | null>(null);
	const [recentConfigs, setRecentConfigs] = useState<GetConfigurationsData>(
		[],
	);
	const [vineyards, setVineyards] = useState<GetVineyardsData>([]);
	const [loading, setLoading] = useState(true);
	const router = useRouter();

	useEffect(() => {
		const fetchData = async () => {
			try {
				const hasIdentity = await hasCloudIdentity();
				if (!hasIdentity) {
					const skipped = localStorage.getItem("aws_onboarding_skipped");
					if (!skipped) {
						router.push("/onboarding/aws");
						return;
					}
				}

				const [statsRes, configsRes, vineyardsRes] = await Promise.all([
					getConfigurationStats(),
					getConfigurations({ limit: 5 }),
					getVineyards(),
				]);

				setStats(statsRes.stats);
				setRecentConfigs(configsRes.configurations || []);
				setVineyards(vineyardsRes.vineyards || []);
			} catch (error) {
				console.error("Error fetching dashboard data:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchData();
	}, [router]);

	return (
		<div className="space-y-8 w-full">
			<div className="flex items-center justify-between">
				<div className="space-y-1.5">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Overview
					</h1>
					<p className="text-muted-foreground text-sm">
						Your infrastructure at a glance.
					</p>
				</div>
				<Link href="/dashboard/configure">
					<Button size="sm" className="h-9 text-sm font-medium">
						<Plus className="mr-2 h-4 w-4" />
						Plant a Vine
					</Button>
				</Link>
			</div>

			{/* Compact Stats Row */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
				<StatCard
					label="Total Vines"
					value={stats?.total_configs}
					loading={loading}
					icon={<TrendingUp className="h-3.5 w-3.5" />}
				/>
				<StatCard
					label="Completed"
					value={stats?.completed_configs}
					loading={loading}
					icon={<CheckCircle2 className="h-3.5 w-3.5" />}
				/>
				<StatCard
					label="Drafts"
					value={stats?.draft_configs}
					loading={loading}
					icon={<Clock className="h-3.5 w-3.5" />}
				/>
				<StatCard
					label="This Month"
					value={stats?.this_month_configs}
					loading={loading}
					icon={<FileText className="h-3.5 w-3.5" />}
				/>
			</div>

			{/* Recent Vines Table */}
			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-medium text-foreground">
						Recent Vines
					</h2>
					<Link href="/dashboard/vines">
						<Button
							variant="ghost"
							size="sm"
							className="text-xs h-7 text-muted-foreground hover:text-foreground"
						>
							View All
							<ArrowRight className="ml-1 h-3 w-3" />
						</Button>
					</Link>
				</div>

				{loading ? (
					<div className="rounded-md border border-border/40">
						<div className="divide-y divide-border/40">
							{[1, 2, 3].map((i) => (
								<div key={i} className="flex items-center gap-4 px-4 py-3">
									<Skeleton className="h-4 w-32" />
									<Skeleton className="h-4 w-16" />
									<Skeleton className="h-4 w-16" />
									<Skeleton className="h-4 w-20 ml-auto" />
								</div>
							))}
						</div>
					</div>
				) : recentConfigs.length === 0 ? (
					<div className="border border-dashed border-border/60 rounded-lg bg-muted/5 flex flex-col items-center justify-center py-12 text-center">
						<FileText className="h-8 w-8 text-muted-foreground mb-3 opacity-30" />
						<p className="text-sm text-muted-foreground mb-4">
							No vines planted yet.
						</p>
						<Link href="/dashboard/configure">
							<Button size="sm" variant="outline" className="h-8 text-xs">
								<Plus className="mr-1.5 h-3.5 w-3.5" />
								Plant your first vine
							</Button>
						</Link>
					</div>
				) : (
					<DataTable
						columns={vinesColumns}
						data={recentConfigs}
						onRowClick={(row) =>
							router.push(`/dashboard/vines?config_id=${row.id}`, {
								scroll: false,
							})
						}
					/>
				)}
			</section>

			{/* Vineyards Summary */}
			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-medium text-foreground">
						Vineyards
					</h2>
					<span className="text-xs text-muted-foreground">
						{loading ? "..." : `${vineyards.length} total`}
					</span>
				</div>

				{loading ? (
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
						{[1, 2].map((i) => (
							<Skeleton key={i} className="h-20 w-full rounded-lg" />
						))}
					</div>
				) : vineyards.length === 0 ? (
					<p className="text-xs text-muted-foreground italic py-2">
						No vineyards yet — they're created automatically when you plant a vine.
					</p>
				) : (
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
						{vineyards.map((v) => (
							<Link
								key={v.id}
								href={`/dashboard/vineyards/${v.id}`}
								className="group flex items-start gap-3 rounded-lg border border-border/40 p-3 hover:border-border hover:bg-muted/30 transition-colors"
							>
								<div className="flex h-8 w-8 items-center justify-center rounded-md border border-border/50 bg-background shrink-0">
									<Map className="h-3.5 w-3.5 text-muted-foreground" />
								</div>
								<div className="flex-1 min-w-0">
									<p className="text-sm font-medium text-foreground truncate group-hover:underline">
										{v.name}
									</p>
									<div className="flex items-center gap-2 mt-0.5">
										<span className="text-xs text-muted-foreground">
											{v.configurations?.length || 0} vines
										</span>
										{v.updated_at && (
											<>
												<span className="text-muted-foreground/30">·</span>
												<span className="text-xs text-muted-foreground">
													{formatDistanceToNow(new Date(v.updated_at), {
														addSuffix: true,
													})}
												</span>
											</>
										)}
									</div>
								</div>
							</Link>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function StatCard({
	label,
	value,
	loading,
	icon,
}: {
	label: string;
	value: number | undefined | null;
	loading: boolean;
	icon: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/40 p-3">
			<div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted/50 text-muted-foreground shrink-0">
				{icon}
			</div>
			<div>
				{loading ? (
					<Skeleton className="h-6 w-8" />
				) : (
					<p className="text-xl font-semibold tracking-tight">
						{value ?? 0}
					</p>
				)}
				<p className="text-[11px] text-muted-foreground leading-none mt-0.5">
					{label}
				</p>
			</div>
		</div>
	);
}
