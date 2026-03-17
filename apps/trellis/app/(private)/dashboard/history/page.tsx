"use client";

import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DatabaseConfiguration } from "@/types/configuration";
import { Calendar, Clock, Download, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export default function HistoryPage() {
	const [configurations, setConfigurations] = useState<
		DatabaseConfiguration[]
	>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchConfigurations = async () => {
			try {
				const res = await fetch("/api/configurations");
				if (res.ok) {
					const data = await res.json();
					setConfigurations(data.configurations || []);
				}
			} catch (error) {
				console.error("[v0] Error fetching configurations:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchConfigurations();
	}, []);

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString("en-US", {
			month: "long",
			day: "numeric",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	const groupByDate = (configs: DatabaseConfiguration[]) => {
		const groups: Record<string, DatabaseConfiguration[]> = {};

		configs.forEach((config) => {
			const date = new Date(config.created_at).toLocaleDateString(
				"en-US",
				{
					month: "long",
					day: "numeric",
					year: "numeric",
				}
			);

			if (!groups[date]) {
				groups[date] = [];
			}
			groups[date].push(config);
		});

		return groups;
	};

	const groupedConfigs = groupByDate(configurations);

	return (
		<div className="space-y-8 w-full max-w-[1000px]">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Deployment History
				</h1>
				<p className="text-muted-foreground text-sm">
					View all your configuration activity and changes over time.
				</p>
			</div>

			{loading ? (
				<div className="space-y-6">
					{[1, 2, 3].map((i) => (
						<Card key={i} className="border-border/40 shadow-sm">
							<CardHeader className="pb-3">
								<Skeleton className="h-6 w-48" />
							</CardHeader>
							<CardContent className="space-y-0 divide-y divide-border/40">
								{[1, 2].map((j) => (
									<div
										key={j}
										className="flex items-center gap-4 py-4"
									>
										<Skeleton className="h-10 w-10 rounded-md" />
										<div className="flex-1 space-y-2">
											<Skeleton className="h-4 w-64" />
											<Skeleton className="h-3 w-48" />
										</div>
									</div>
								))}
							</CardContent>
						</Card>
					))}
				</div>
			) : configurations.length === 0 ? (
				<Card className="border-border/40 shadow-sm bg-muted/10">
					<CardContent className="flex flex-col items-center justify-center py-16 text-center">
						<Clock className="h-12 w-12 text-muted-foreground mb-4 opacity-30" />
						<h3 className="text-sm font-medium text-foreground mb-1">
							No history yet
						</h3>
						<p className="text-xs text-muted-foreground max-w-sm">
							Your deployment history will appear here once
							you create and deploy configurations.
						</p>
					</CardContent>
				</Card>
			) : (
				<div className="space-y-6">
					{Object.entries(groupedConfigs).map(([date, configs]) => (
						<Card key={date} className="border-border/40 shadow-sm overflow-hidden">
							<CardHeader className="bg-muted/20 border-b border-border/40 py-3 px-4 sm:px-6">
								<div className="flex items-center justify-between">
									<CardTitle className="text-sm font-medium flex items-center gap-2 text-foreground">
										<Calendar className="h-4 w-4 text-muted-foreground" />
										{date}
									</CardTitle>
									<CardDescription className="text-xs">
										{configs.length} configuration{configs.length !== 1 && 's'}
									</CardDescription>
								</div>
							</CardHeader>
							<CardContent className="p-0">
								<div className="space-y-0 divide-y divide-border/40">
									{configs.map((config) => (
										<div
											key={config.id}
											className="flex items-start gap-4 p-4 sm:p-6 hover:bg-muted/30 transition-colors group"
										>
											<div className="h-10 w-10 rounded-md border border-border/50 bg-background flex items-center justify-center flex-shrink-0 group-hover:border-border transition-colors">
												<Folder className="h-4.5 w-4.5 text-muted-foreground" />
											</div>
											<div className="flex-1 min-w-0">
												<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-1.5">
													<div>
														<h4 className="text-sm font-medium text-foreground group-hover:underline">
															{config.name}
														</h4>
														<p className="text-[11px] text-muted-foreground mt-0.5 truncate">
															{config.project_name} • {config.environment_stage} • {config.aws_region}
														</p>
													</div>
													<Badge
														variant="outline"
														className={cn(
															"font-medium text-[10px] uppercase px-2.5 py-0.5 h-5 border-border/50 w-fit",
															config.status === "completed"
																? "text-foreground bg-foreground/5 border-foreground/10"
																: "text-muted-foreground bg-muted/30"
														)}
													>
														{config.status}
													</Badge>
												</div>
												<div className="flex items-center gap-4 text-[11px] text-muted-foreground mt-2">
													<span className="flex items-center gap-1.5">
														<Clock className="h-3 w-3 opacity-70" />
														{formatDate(config.created_at)}
													</span>
													{config.download_count > 0 && (
														<span className="flex items-center gap-1.5">
															<Download className="h-3 w-3 opacity-70" />
															Downloaded {config.download_count} time{config.download_count !== 1 && 's'}
														</span>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}