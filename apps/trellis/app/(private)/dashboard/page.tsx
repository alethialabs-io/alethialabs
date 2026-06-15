"use client";

import { getIntegrationsWithStatus, type IntegrationWithConnection } from "@/app/server/actions/integrations";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	ArrowRight,
	CheckCircle2,
	ClipboardList,
	Grape,
	Plus,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function DashboardPage() {
	const router = useRouter();
	const jobsStore = useJobsStore();
	const vineyardsStore = useVineyardsStore();

	const [integrations, setIntegrations] = useState<IntegrationWithConnection[]>([]);
	const [onlineTendrils, setOnlineWorkers] = useState(0);

	useEffect(() => {
		jobsStore.fetchJobs();
		vineyardsStore.fetchVineyards();
		getIntegrationsWithStatus().then(setIntegrations).catch(() => {});

		const supabase = createClient();
		supabase
			.from("workers")
			.select("id, status")
			.eq("status", "ONLINE")
			.then(({ data }) => setOnlineWorkers(data?.length ?? 0));
	}, []);

	const allVines = useMemo(
		() => vineyardsStore.vineyards.flatMap((vy) => vy.vines ?? []),
		[vineyardsStore.vineyards],
	);
	const activeVines = allVines.filter((v) => v.status === "ACTIVE").length;

	const recentJobs = useMemo(
		() => jobsStore.jobs.slice(0, 5),
		[jobsStore.jobs],
	);

	const connectedIntegrations = integrations.filter((i) => i.connected);
	const disconnectedIntegrations = integrations.filter(
		(i) => !i.connected && i.status !== "coming_soon",
	);

	const handleJobClick = (job: PublicProvisionJobsRow) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	if (jobsStore.isLoading && vineyardsStore.isLoading) {
		return (
			<div className="space-y-8 w-full">
				<div className="flex items-center justify-between">
					<div className="space-y-1">
						<Skeleton className="h-7 w-28" />
						<Skeleton className="h-4 w-52" />
					</div>
					<Skeleton className="h-8 w-28 rounded-md" />
				</div>

				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					{[1, 2, 3, 4].map((i) => (
						<div key={i} className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5">
							<Skeleton className="h-7 w-7 rounded-md" />
							<div className="space-y-1">
								<Skeleton className="h-5 w-8" />
								<Skeleton className="h-2.5 w-14" />
							</div>
						</div>
					))}
				</div>

				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-6 w-16" />
					</div>
					<div className="flex flex-wrap gap-2">
						{[1, 2, 3, 4].map((i) => (
							<Skeleton key={i} className="h-7 w-28 rounded-full" />
						))}
					</div>
				</div>

				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-6 w-16" />
					</div>
					<div className="rounded-lg border border-border/40">
						<div className="flex gap-4 border-b border-border/40 p-3">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-3 w-20" />
							))}
						</div>
						{[1, 2, 3, 4, 5].map((i) => (
							<div key={i} className="flex gap-4 border-b border-border/20 p-3">
								<Skeleton className="h-3 w-16" />
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-3 w-14 rounded-full" />
								<Skeleton className="h-3 w-24" />
								<Skeleton className="h-3 w-28" />
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}

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
				<StatChip icon={<Grape className="h-3.5 w-3.5" />} value={allVines.length} label="Vines" />
				<StatChip icon={<CheckCircle2 className="h-3.5 w-3.5" />} value={activeVines} label="Active" />
				<StatChip icon={<Workflow className="h-3.5 w-3.5" />} value={onlineTendrils} label={`Tendril${onlineTendrils !== 1 ? "s" : ""} Online`} />
				<StatChip icon={<ClipboardList className="h-3.5 w-3.5" />} value={jobsStore.jobs.length} label="Total Jobs" />
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
							<span className="h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
							<span className="font-medium">{i.name}</span>
							<span className="text-muted-foreground">
								{i.connection_details?.username
									? `@${i.connection_details.username}`
									: i.connection_details?.account_id
										?? i.connection_details?.project_id
										?? i.connection_details?.subscription_id
										?? ""}
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
							onRowClick={handleJobClick}
							pageSize={5}
						/>
					)}
				</div>
			</section>
		</div>
	);
}

function SectionHeader({ title, href, linkText }: { title: string; href: string; linkText: string }) {
	return (
		<div className="flex items-center justify-between">
			<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
			<Link href={href}>
				<Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground hover:text-foreground">
					{linkText}
					<ArrowRight className="ml-1 h-3 w-3" />
				</Button>
			</Link>
		</div>
	);
}

function StatChip({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5">
			<div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/50 text-muted-foreground shrink-0">
				{icon}
			</div>
			<div>
				<p className="text-lg font-semibold tracking-tight leading-none">{value}</p>
				<p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
			</div>
		</div>
	);
}
