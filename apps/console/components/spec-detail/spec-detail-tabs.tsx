"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { DataTable } from "@/components/data-table";
import { JOB_TYPES } from "@/components/jobs/columns";
import { PlanTab } from "@/components/plan/plan-tab";
import type { UsePlanReturn } from "@/components/plan/use-plan";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getProvider, DB_CAPACITY, type CloudProviderSlug } from "@/lib/cloud-providers";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobType } from "@/lib/db/schema";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
	CheckCircle2,
	DollarSign,
	FileText,
	Globe,
	Layers,
	Settings2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Boxes } from "lucide-react";
import { ClusterAccess } from "./cluster-access";
import { EnvironmentsTab } from "./environments-tab";
import { InfrastructureTab } from "./infrastructure-tab";
import { ServicesTab } from "./services-tab";
import type { ServiceInstance } from "./service-card";

export type SpecDetail = {
	spec: {
		id: string;
		project_name: string;
		status: string;
		region: string;
		iac_version: string;
		environment_stage: string;
		estimated_monthly_cost: number | null;
		[key: string]: unknown;
	};
	// M1: the spec's environments (the default + any added). Drives the Environments tab.
	environments?: {
		id: string;
		name: string;
		stage: string;
		status: string;
		region: string | null;
		is_default: boolean;
	}[];
	cloudProvider: string;
	components: {
		network: Record<string, unknown> | null;
		cluster: Record<string, unknown> | null;
		dns: Record<string, unknown> | null;
		repositories: Record<string, unknown> | null;
		databases: ServiceInstance[];
		caches: ServiceInstance[];
		queues: ServiceInstance[];
		topics: ServiceInstance[];
		nosql_tables: ServiceInstance[];
		secrets: ServiceInstance[];
	};
};

interface SpecDetailTabsProps {
	detail: SpecDetail;
	specId: string;
	plan: UsePlanReturn;
	onApplied: (deployJobId: string) => void;
}


const specJobColumns: ColumnDef<JobWithMeta>[] = [
	{
		accessorKey: "job_type",
		header: "Type",
		enableSorting: true,
		cell: ({ row }) => {
			const type = row.getValue<ProvisionJobType>("job_type");
			const info = JOB_TYPES[type];
			if (!info) return <span className="text-xs">{type}</span>;
			const Icon = info.icon;
			return (
				<div className="flex items-center gap-2">
					<Icon className="h-3.5 w-3.5 text-muted-foreground" />
					<div>
						<span className="text-xs font-medium">{info.label}</span>
						<p className="text-[10px] text-muted-foreground hidden sm:block">{info.description}</p>
					</div>
				</div>
			);
		},
	},
	{
		accessorKey: "status",
		header: "Status",
		enableSorting: true,
		cell: ({ row }) => {
			const status = row.getValue<string>("status");
			return <StatusBadge status={status} />;
		},
	},
	{
		accessorKey: "created_at",
		header: "Created",
		enableSorting: true,
		cell: ({ row }) => {
			const date = row.getValue("created_at") as string | null;
			if (!date) return <span className="text-xs text-muted-foreground">—</span>;
			return (
				<span className="text-xs text-muted-foreground">
					{formatDistanceToNow(new Date(date), { addSuffix: true })}
				</span>
			);
		},
	},
	{
		id: "duration",
		header: "Duration",
		enableSorting: true,
		accessorFn: (row) => {
			if (!row.created_at) return null;
			const end = row.completed_at ? new Date(row.completed_at) : new Date();
			return end.getTime() - new Date(row.created_at).getTime();
		},
		cell: ({ row }) => {
			const created = row.original.created_at;
			const completed = row.original.completed_at;
			const status = row.original.status;
			if (!created) return <span className="text-xs text-muted-foreground">—</span>;
			if (!completed && (status === "PROCESSING" || status === "CLAIMED")) {
				return <span className="text-xs text-muted-foreground animate-pulse">Running...</span>;
			}
			if (!completed) return <span className="text-xs text-muted-foreground">—</span>;
			const ms = new Date(completed).getTime() - new Date(created).getTime();
			const mins = Math.floor(ms / 60000);
			const secs = Math.floor((ms % 60000) / 1000);
			return <span className="text-xs font-mono text-muted-foreground">{mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}</span>;
		},
	},
];

export function SpecDetailTabs({ detail, specId, plan, onApplied }: SpecDetailTabsProps) {
	const searchParams = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();

	const activeTab = searchParams.get("tab") || "config";
	const setTab = (tab: string) => {
		const params = new URLSearchParams(searchParams.toString());
		params.set("tab", tab);
		router.replace(`${pathname}?${params.toString()}`, { scroll: false });
	};

	const { spec, cloudProvider, components } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const providerMeta = getProvider(providerSlug);
	const capacity = DB_CAPACITY[providerSlug];

	const totalServices =
		components.databases.length +
		components.caches.length +
		components.queues.length +
		components.topics.length +
		components.nosql_tables.length +
		components.secrets.length;

	const allJobs = useJobsStore((s) => s.jobs);
	const jobs = useMemo(
		() => allJobs.filter((j) => j.spec_id === specId).slice(0, 5),
		[allJobs, specId],
	);

	const cluster = components.cluster as { cluster_name: string | null; cluster_endpoint: string | null } | null;
	const dns = components.dns as { domain_name: string | null } | null;

	const handleJobClick = (job: JobWithMeta) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	return (
		<Tabs value={activeTab} onValueChange={setTab}>
			<TabsList className="w-full justify-start border-b bg-transparent p-0 h-auto">
				<TabsTrigger
					value="config"
					className="rounded-none border-b-2 border-transparent px-3 py-2 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
				>
					<Settings2 className="h-3.5 w-3.5 mr-1.5" />
					Configuration
				</TabsTrigger>
				<TabsTrigger
					value="environments"
					className="rounded-none border-b-2 border-transparent px-3 py-2 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
				>
					<Boxes className="h-3.5 w-3.5 mr-1.5" />
					Environments
				</TabsTrigger>
								<TabsTrigger
						value="plan"
						className="rounded-none border-b-2 border-transparent px-3 py-2 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
					>
						<FileText className="h-3.5 w-3.5 mr-1.5" />
						Plan
						{plan.phase !== "idle" && plan.phase !== "failed" && (
							<StatusBadge status="processing" showLabel={false} className="ml-1.5" />
						)}
					</TabsTrigger>
			</TabsList>

			<TabsContent value="config" className="mt-6">
				<div className="space-y-8">
					{/* Quick Stats */}
					<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
						<StatChip icon={<Layers className="h-3.5 w-3.5" />} value={String(totalServices)} label="Services" />
						<StatChip icon={<DollarSign className="h-3.5 w-3.5" />} value={spec.estimated_monthly_cost ? `$${Math.round(spec.estimated_monthly_cost)}` : "—"} label="Est. Monthly" />
						<StatChip icon={<CheckCircle2 className="h-3.5 w-3.5" />} value={spec.status} label="Status" />
						<StatChip icon={<Globe className="h-3.5 w-3.5" />} value={`${providerMeta.shortName} · ${spec.region}`} label="Provider" />
					</div>

					{/* Cluster Access */}
					{(cluster?.cluster_name || cluster?.cluster_endpoint) && (
						<Card>
							<CardContent className="pt-5">
								<ClusterAccess
									clusterName={cluster.cluster_name}
									clusterEndpoint={cluster.cluster_endpoint}
									region={spec.region}
									dnsDomain={dns?.domain_name ?? null}
								/>
							</CardContent>
						</Card>
					)}

					{/* Infrastructure */}
					<InfrastructureTab
						spec={spec}
						components={{
							network: components.network as InfraTabNetwork,
							cluster: components.cluster as InfraTabCluster,
							dns: components.dns as InfraTabDns,
							repositories: components.repositories as InfraTabRepos,
						}}
						providerMeta={providerMeta}
					/>

					{/* Services */}
					{totalServices > 0 && (
						<ServicesTab
							components={components}
							providerMeta={providerMeta}
							capacityUnit={capacity.unit}
						/>
					)}

					{/* Recent Jobs */}
					{jobs.length > 0 && (
						<section className="space-y-3">
							<div className="flex items-center justify-between">
								<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Jobs</h3>
								<Link href="/dashboard/jobs" className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
									View all
								</Link>
							</div>
							<DataTable columns={specJobColumns} data={jobs} onRowClick={handleJobClick} pageSize={5} />
						</section>
					)}
				</div>
			</TabsContent>

			<TabsContent value="environments" className="mt-6">
				<EnvironmentsTab specId={specId} environments={detail.environments ?? []} />
			</TabsContent>

			<TabsContent value="plan" className="mt-6">
				{plan.phase === "idle" ? (
					<p className="text-sm text-muted-foreground py-4">
						No plan generated yet. Use the Plan button above to preview infrastructure changes.
					</p>
				) : (
					<PlanTab plan={plan} onApplied={onApplied} />
				)}
			</TabsContent>
		</Tabs>
	);
}

function StatChip({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2.5">
			<div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/50 text-muted-foreground shrink-0">
				{icon}
			</div>
			<div className="min-w-0">
				<p className="text-sm font-semibold tracking-tight leading-none truncate">{value}</p>
				<p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
			</div>
		</div>
	);
}

type InfraTabNetwork = {
	provision_network: boolean | null;
	cidr_block: string | null;
	single_nat_gateway: boolean | null;
	network_id: string | null;
} | null;
type InfraTabCluster = {
	cluster_version: string | null;
	node_min_size: number | null;
	node_max_size: number | null;
	node_desired_size: number | null;
	instance_types: string[] | null;
	cluster_admins: unknown[] | null;
} | null;
type InfraTabDns = {
	enabled: boolean | null;
	domain_name: string | null;
	zone_id: string | null;
	managed_certificate: boolean | null;
	waf_enabled: boolean | null;
} | null;
type InfraTabRepos = {
	apps_destination_repo: string | null;
} | null;
