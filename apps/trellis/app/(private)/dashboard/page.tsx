import { getJobs } from "@/app/server/actions/jobs";
import { getIntegrationsWithStatus } from "@/app/server/actions/integrations";
import { getVineyards } from "@/app/server/actions/vineyards";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { JOB_TYPES, STATUS_STYLES } from "@/components/jobs/columns";
import {
	ArrowRight,
	Blocks,
	CheckCircle2,
	ClipboardList,
	Grape,
	Map,
	Plus,
	Workflow,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

export default async function DashboardPage() {
	const supabase = await createClient();

	const [jobs, integrations, { vineyards }, workersResult] =
		await Promise.all([
			getJobs(),
			getIntegrationsWithStatus(),
			getVineyards(),
			supabase
				.from("workers")
				.select("id, name, mode, status, last_heartbeat, created_at")
				.order("created_at", { ascending: false }),
		]);

	const recentJobs = jobs.slice(0, 5);
	const workers = workersResult.data ?? [];
	const onlineWorkers = workers.filter((w) => w.status === "ONLINE").length;
	const offlineWorkers = workers.length - onlineWorkers;

	const connectedIntegrations = integrations.filter((i) => i.connected);
	const availableIntegrations = integrations.filter(
		(i) => !i.connected && i.status !== "coming_soon",
	);

	return (
		<div className="space-y-6 w-full">
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Overview
					</h1>
					<p className="text-muted-foreground text-sm">
						Your infrastructure at a glance.
					</p>
				</div>
				<Link href="/dashboard/plant">
					<Button size="sm" className="h-8 text-xs">
						<Plus className="mr-1.5 h-3.5 w-3.5" />
						Plant a Vine
					</Button>
				</Link>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{/* Recent Jobs */}
				<Card>
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<ClipboardList className="h-4 w-4 text-muted-foreground" />
								<CardTitle className="text-sm">
									Recent Jobs
								</CardTitle>
							</div>
							<Link href="/dashboard/jobs">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] text-muted-foreground"
								>
									View all
									<ArrowRight className="ml-1 h-3 w-3" />
								</Button>
							</Link>
						</div>
					</CardHeader>
					<CardContent>
						{recentJobs.length === 0 ? (
							<p className="text-xs text-muted-foreground py-4 text-center">
								No jobs yet. Plant a vine to get started.
							</p>
						) : (
							<div className="space-y-1">
								{recentJobs.map((job) => {
									const info = JOB_TYPES[job.job_type];
									const Icon = info?.icon;
									return (
										<div
											key={job.id}
											className="flex items-center gap-3 py-1.5 px-1"
										>
											{Icon && (
												<Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
											)}
											<span className="text-xs font-medium flex-1 truncate">
												{info?.label ?? job.job_type}
											</span>
											<Badge
												variant="outline"
												className={`text-[9px] py-0 px-1.5 ${STATUS_STYLES[job.status] ?? ""}`}
											>
												{job.status}
											</Badge>
											<span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
												{job.created_at
													? formatDistanceToNow(
															new Date(
																job.created_at,
															),
															{ addSuffix: true },
														)
													: "—"}
											</span>
										</div>
									);
								})}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Integrations */}
				<Card>
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Blocks className="h-4 w-4 text-muted-foreground" />
								<CardTitle className="text-sm">
									Integrations
								</CardTitle>
							</div>
							<Link href="/dashboard/integrations">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] text-muted-foreground"
								>
									Manage
									<ArrowRight className="ml-1 h-3 w-3" />
								</Button>
							</Link>
						</div>
					</CardHeader>
					<CardContent>
						<div className="space-y-1.5">
							{connectedIntegrations.map((i) => (
								<div
									key={i.slug}
									className="flex items-center gap-2.5 py-1"
								>
									<CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
									<span className="text-xs font-medium">
										{i.name}
									</span>
									<span className="text-[10px] text-muted-foreground truncate">
										{i.connection_details?.username
											? `@${i.connection_details.username}`
											: i.connection_details?.account_id
												? i.connection_details.account_id
												: ""}
									</span>
								</div>
							))}
							{availableIntegrations.map((i) => (
								<div
									key={i.slug}
									className="flex items-center gap-2.5 py-1"
								>
									<XCircle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
									<span className="text-xs text-muted-foreground">
										{i.name}
									</span>
									<Link
										href="/dashboard/integrations"
										className="text-[10px] text-foreground hover:underline ml-auto"
									>
										Connect
									</Link>
								</div>
							))}
							{connectedIntegrations.length === 0 &&
								availableIntegrations.length === 0 && (
									<p className="text-xs text-muted-foreground py-2 text-center">
										No integrations available.
									</p>
								)}
						</div>
					</CardContent>
				</Card>

				{/* Workers */}
				<Card>
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Workflow className="h-4 w-4 text-muted-foreground" />
								<CardTitle className="text-sm">
									Workers
								</CardTitle>
								{workers.length > 0 && (
									<span className="text-[10px] text-muted-foreground">
										{onlineWorkers} online
										{offlineWorkers > 0 &&
											` · ${offlineWorkers} offline`}
									</span>
								)}
							</div>
							<Link href="/dashboard/workers">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] text-muted-foreground"
								>
									{workers.length === 0
										? "Register"
										: "Manage"}
									<ArrowRight className="ml-1 h-3 w-3" />
								</Button>
							</Link>
						</div>
					</CardHeader>
					<CardContent>
						{workers.length === 0 ? (
							<p className="text-xs text-muted-foreground py-4 text-center">
								No workers registered. Register one to start
								provisioning.
							</p>
						) : (
							<div className="space-y-1.5">
								{workers.map((w) => (
									<div
										key={w.id}
										className="flex items-center gap-2.5 py-1"
									>
										<div
											className={`h-2 w-2 rounded-full shrink-0 ${w.status === "ONLINE" ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
										/>
										<span className="text-xs font-medium truncate">
											{w.name}
										</span>
										<Badge
											variant="outline"
											className="text-[9px] py-0 px-1.5"
										>
											{w.mode}
										</Badge>
										{w.last_heartbeat && (
											<span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
												{formatDistanceToNow(
													new Date(w.last_heartbeat),
													{ addSuffix: true },
												)}
											</span>
										)}
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Vineyards */}
				<Card>
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Grape className="h-4 w-4 text-muted-foreground" />
								<CardTitle className="text-sm">
									Vineyards
								</CardTitle>
								{vineyards.length > 0 && (
									<span className="text-[10px] text-muted-foreground">
										{vineyards.length} total
									</span>
								)}
							</div>
							<Link href="/dashboard/vineyards">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] text-muted-foreground"
								>
									View all
									<ArrowRight className="ml-1 h-3 w-3" />
								</Button>
							</Link>
						</div>
					</CardHeader>
					<CardContent>
						{vineyards.length === 0 ? (
							<p className="text-xs text-muted-foreground py-4 text-center">
								No vineyards yet — created automatically when
								you plant a vine.
							</p>
						) : (
							<div className="space-y-1.5">
								{vineyards.slice(0, 3).map((v) => (
									<Link
										key={v.id}
										href={`/dashboard/vineyards/${v.id}`}
										className="flex items-center gap-2.5 py-1.5 px-1 rounded hover:bg-muted/30 transition-colors"
									>
										<Map className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
										<span className="text-xs font-medium truncate flex-1">
											{v.name}
										</span>
										<span className="text-[10px] text-muted-foreground tabular-nums">
											{v.vines?.length ?? 0} vine
											{(v.vines?.length ?? 0) !== 1
												? "s"
												: ""}
										</span>
									</Link>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
