import { getJobs } from "@/app/server/actions/jobs";
import { getIntegrationsWithStatus } from "@/app/server/actions/integrations";
import { getVineyards } from "@/app/server/actions/vineyards";
import { getVines } from "@/app/server/actions/vines";
import { createClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { jobColumns, JOB_TYPES, STATUS_STYLES } from "@/components/jobs/columns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	ArrowRight,
	Blocks,
	CheckCircle2,
	ClipboardList,
	Grape,
	Map,
	Plus,
	Server,
	Workflow,
	XCircle,
} from "lucide-react";
import Link from "next/link";

export default async function DashboardPage() {
	const supabase = await createClient();

	const [jobs, integrations, { vineyards }, { vines }, workersResult] =
		await Promise.all([
			getJobs(),
			getIntegrationsWithStatus(),
			getVineyards(),
			getVines(),
			supabase
				.from("workers")
				.select("id, name, mode, status, last_heartbeat")
				.order("created_at", { ascending: false }),
		]);

	const recentJobs = jobs.slice(0, 5);
	const workers = workersResult.data ?? [];
	const onlineWorkers = workers.filter((w) => w.status === "ONLINE").length;
	const activeVines = vines.filter((v) => v.status === "ACTIVE").length;

	const connectedIntegrations = integrations.filter((i) => i.connected);
	const disconnectedIntegrations = integrations.filter(
		(i) => !i.connected && i.status !== "coming_soon",
	);

	return (
		<div className="space-y-8 w-full">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Overview
					</h1>
					<p className="text-sm text-muted-foreground mt-1">
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

			{/* Stats Strip */}
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<StatChip icon={<Grape className="h-3.5 w-3.5" />} value={vines.length} label="Vines" />
				<StatChip icon={<CheckCircle2 className="h-3.5 w-3.5" />} value={activeVines} label="Active" />
				<StatChip icon={<Workflow className="h-3.5 w-3.5" />} value={onlineWorkers} label={`Worker${onlineWorkers !== 1 ? "s" : ""} Online`} />
				<StatChip icon={<ClipboardList className="h-3.5 w-3.5" />} value={jobs.length} label="Total Jobs" />
			</div>

			{/* Integrations */}
			<section>
				<SectionHeader title="Integrations" href="/dashboard/integrations" linkText="Manage" />
				<div className="flex flex-wrap gap-2 mt-3">
					{connectedIntegrations.map((i) => (
						<div
							key={i.slug}
							className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border/40 bg-background text-xs"
						>
							<span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
							<span className="font-medium">{i.name}</span>
							<span className="text-muted-foreground">
								{i.connection_details?.username
									? `@${i.connection_details.username}`
									: i.connection_details?.account_id ?? ""}
							</span>
						</div>
					))}
					{disconnectedIntegrations.map((i) => (
						<Link
							key={i.slug}
							href="/dashboard/integrations"
							className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-dashed border-border/50 text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors"
						>
							<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
							<span>{i.name}</span>
							<span className="text-[10px]">Connect</span>
						</Link>
					))}
					{connectedIntegrations.length === 0 && disconnectedIntegrations.length === 0 && (
						<p className="text-xs text-muted-foreground">No integrations available.</p>
					)}
				</div>
			</section>

			{/* Recent Jobs */}
			<section>
				<SectionHeader title="Recent Jobs" href="/dashboard/jobs" linkText="View all" />
				<div className="mt-3">
					{recentJobs.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-border/50 rounded-lg">
							<ClipboardList className="h-6 w-6 text-muted-foreground/30 mb-2" />
							<p className="text-xs text-muted-foreground">
								No jobs yet. Plant a vine to get started.
							</p>
						</div>
					) : (
						<DataTable
							columns={jobColumns}
							data={recentJobs}
							pageSize={5}
						/>
					)}
				</div>
			</section>

			{/* Vineyards */}
			<section>
				<SectionHeader
					title={`Vineyards${vineyards.length > 0 ? ` (${vineyards.length})` : ""}`}
					href="/dashboard/vineyards"
					linkText="View all"
				/>
				<div className="mt-3">
					{vineyards.length === 0 ? (
						<p className="text-xs text-muted-foreground py-2">
							No vineyards yet — created automatically when you plant a vine.
						</p>
					) : (
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{vineyards.slice(0, 3).map((v) => {
								const vineCount = v.vines?.length ?? 0;
								const active = (v.vines ?? []).filter(
									(vine) => vine.status === "ACTIVE",
								).length;

								return (
									<Link
										key={v.id}
										href={`/dashboard/vineyards/${v.id}`}
									>
										<div className="group p-4 rounded-lg border border-border/50 bg-background hover:bg-muted/30 hover:border-border transition-colors">
											<div className="flex items-start justify-between mb-2">
												<div className="p-1.5 bg-muted/50 rounded-md border border-border/50">
													<Map className="h-3.5 w-3.5 text-muted-foreground" />
												</div>
												{active > 0 && (
													<Badge
														variant="outline"
														className="text-[9px] py-0 text-emerald-600 border-emerald-200 bg-emerald-50"
													>
														{active} active
													</Badge>
												)}
											</div>
											<p className="text-sm font-medium text-foreground group-hover:text-foreground truncate">
												{v.name}
											</p>
											<p className="text-[11px] text-muted-foreground mt-0.5">
												{vineCount} vine{vineCount !== 1 ? "s" : ""}
											</p>
										</div>
									</Link>
								);
							})}
						</div>
					)}
				</div>
			</section>
		</div>
	);
}

function SectionHeader({
	title,
	href,
	linkText,
}: {
	title: string;
	href: string;
	linkText: string;
}) {
	return (
		<div className="flex items-center justify-between">
			<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</h2>
			<Link href={href}>
				<Button
					variant="ghost"
					size="sm"
					className="h-6 text-[10px] text-muted-foreground hover:text-foreground"
				>
					{linkText}
					<ArrowRight className="ml-1 h-3 w-3" />
				</Button>
			</Link>
		</div>
	);
}

function StatChip({
	icon,
	value,
	label,
}: {
	icon: React.ReactNode;
	value: number;
	label: string;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5">
			<div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/50 text-muted-foreground shrink-0">
				{icon}
			</div>
			<div>
				<p className="text-lg font-semibold tracking-tight leading-none">
					{value}
				</p>
				<p className="text-[10px] text-muted-foreground mt-0.5">
					{label}
				</p>
			</div>
		</div>
	);
}
