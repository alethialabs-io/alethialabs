"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getVine, planVine, provisionVine, deleteVine } from "@/app/server/actions/vines";
import { getVineJobs } from "@/app/server/actions/jobs";
import { getProvider, DB_CAPACITY, type CloudProviderSlug } from "@/lib/cloud-providers";
import { JOB_TYPES, STATUS_STYLES as JOB_STATUS_STYLES } from "@/components/jobs/columns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	ArrowLeft,
	ArrowRightLeft,
	Cloud,
	Database,
	FileText,
	GitBranch,
	Globe,
	Key,
	Loader2,
	Lock,
	MessageSquare,
	MoreHorizontal,
	Network,
	Rocket,
	Server,
	Table,
	Trash2,
	Zap,
	type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import type { PublicProvisionJobsRow } from "@/lib/validations/db.schemas";

type VineDetail = Awaited<ReturnType<typeof getVine>>;

const VINE_STATUS_STYLES: Record<string, string> = {
	ACTIVE: "text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	DRAFT: "text-muted-foreground border-border bg-muted/50",
	QUEUED: "text-blue-600 border-blue-200 bg-blue-50",
	PROVISIONING: "text-amber-600 border-amber-200 bg-amber-50",
	FAILED: "text-destructive border-destructive/30 bg-destructive/10",
	DESTROYING: "text-orange-600 border-orange-200 bg-orange-50",
	DESTROYED: "text-muted-foreground border-border bg-muted/30",
};

function SectionTitle({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
	return (
		<div className="flex items-center gap-2 mb-3">
			<Icon className="h-4 w-4 text-muted-foreground" />
			<h4 className="font-medium text-xs text-muted-foreground uppercase tracking-wider">{title}</h4>
		</div>
	);
}

function Field({ label, value, mono }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
	return (
		<div>
			<p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
			<p className={`text-sm font-medium ${mono ? "font-mono" : ""}`}>{value ?? "—"}</p>
		</div>
	);
}

export default function VineDetailPage() {
	const { id: vineyardId, vineId } = useParams<{ id: string; vineId: string }>();
	const router = useRouter();
	const [detail, setDetail] = useState<VineDetail | null>(null);
	const [jobs, setJobs] = useState<PublicProvisionJobsRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState<string | null>(null);

	useEffect(() => {
		Promise.all([
			getVine(vineId),
			getVineJobs(vineId),
		]).then(([vineData, jobsData]) => {
			setDetail(vineData);
			setJobs((jobsData as PublicProvisionJobsRow[]).slice(0, 5));
			setLoading(false);
		}).catch(() => setLoading(false));
	}, [vineId]);

	if (loading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	if (!detail) {
		return (
			<div className="space-y-4">
				<Link href={`/dashboard/vineyards/${vineyardId}`}>
					<Button variant="ghost" size="sm" className="text-xs">
						<ArrowLeft className="h-3.5 w-3.5 mr-1.5" />Back
					</Button>
				</Link>
				<p className="text-muted-foreground text-sm">Vine not found.</p>
			</div>
		);
	}

	const { vine, components, cloudProvider } = detail;
	const providerSlug = (cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);
	const capacity = DB_CAPACITY[providerSlug];

	const handlePlan = async () => {
		setActionLoading("plan");
		try {
			const { jobId } = await planVine(vineId);
			toast.success("Plan job queued");
			router.push(`/dashboard/jobs/${jobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to plan");
		} finally {
			setActionLoading(null);
		}
	};

	const handleDeploy = async () => {
		setActionLoading("deploy");
		try {
			const { jobId } = await provisionVine(vineId);
			toast.success("Deploy job queued");
			router.push(`/dashboard/jobs/${jobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to deploy");
		} finally {
			setActionLoading(null);
		}
	};

	const handleDelete = async () => {
		if (!confirm("Delete this vine and all its components?")) return;
		try {
			await deleteVine(vineId);
			toast.success("Vine deleted");
			router.push(`/dashboard/vineyards/${vineyardId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		}
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Link href={`/dashboard/vineyards/${vineyardId}`}>
						<Button variant="ghost" size="icon" className="h-8 w-8">
							<ArrowLeft className="h-4 w-4" />
						</Button>
					</Link>
					<div className="flex items-center gap-3">
						<Image src={meta.icon} alt={meta.shortName} width={24} height={24} />
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-lg font-semibold">{vine.project_name}</h1>
								<Badge variant="outline" className={`text-[10px] ${VINE_STATUS_STYLES[vine.status] ?? ""}`}>
									{vine.status}
								</Badge>
							</div>
							<p className="text-xs text-muted-foreground">
								{meta.shortName} · {vine.region} · {vine.environment_stage}
								{vine.estimated_monthly_cost ? ` · ~$${Math.round(vine.estimated_monthly_cost)}/mo` : ""}
							</p>
						</div>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<Button variant="outline" size="sm" className="h-8 text-xs" onClick={handlePlan} disabled={!!actionLoading}>
						{actionLoading === "plan" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
						Plan
					</Button>
					<Button size="sm" className="h-8 text-xs" onClick={handleDeploy} disabled={!!actionLoading}>
						{actionLoading === "deploy" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5 mr-1.5" />}
						Deploy
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="h-8 w-8">
								<MoreHorizontal className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => router.push(`/dashboard/plant`)}>
								<ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
								Duplicate for Provider
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
								<Trash2 className="h-3.5 w-3.5 mr-2" />
								Delete Vine
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Configuration */}
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-sm">Configuration</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<Field label="Terraform" value={`v${vine.terraform_version}`} mono />
						<Field label="Provider" value={meta.shortName} />
						<Field label="Region" value={vine.region} mono />
						<Field label="Environment" value={vine.environment_stage} />
					</div>

					{components.network && (
						<>
							<Separator />
							<SectionTitle icon={Network} title={`${meta.networkName}`} />
							<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
								<Field label="Mode" value={components.network.provision_network ? "Create New" : "Use Existing"} />
								{components.network.cidr_block && <Field label="CIDR" value={components.network.cidr_block} mono />}
								<Field label="NAT" value={components.network.single_nat_gateway ? "Single" : "Per AZ"} />
							</div>
						</>
					)}

					{components.cluster && (
						<>
							<Separator />
							<SectionTitle icon={Server} title={`${meta.clusterService} Cluster`} />
							<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
								<Field label="Version" value={`v${components.cluster.cluster_version}`} mono />
								<Field label="Nodes" value={`${components.cluster.node_min_size}-${components.cluster.node_max_size}`} />
								<Field label="Types" value={(components.cluster.instance_types as string[])?.join(", ")} mono />
							</div>
						</>
					)}

					{components.dns?.enabled && (
						<>
							<Separator />
							<SectionTitle icon={Globe} title="DNS" />
							<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
								<Field label="Domain" value={components.dns.domain_name} mono />
								<Field label="Zone" value={components.dns.zone_id} mono />
							</div>
						</>
					)}
				</CardContent>
			</Card>

			{/* Services */}
			{(components.databases.length > 0 || components.caches.length > 0 || components.queues.length > 0 || components.topics.length > 0 || components.nosql_tables.length > 0 || components.secrets.length > 0) && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm">
							Services ({components.databases.length + components.caches.length + components.queues.length + components.topics.length + components.nosql_tables.length + components.secrets.length})
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						{components.databases.map((db: any) => (
							<div key={db.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<Database className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{db.name}</span>
								</div>
								<span className="text-muted-foreground">{db.engine} · {db.min_capacity}-{db.max_capacity} {capacity.unit}</span>
							</div>
						))}
						{components.caches.map((c: any) => (
							<div key={c.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<Zap className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{c.name}</span>
								</div>
								<span className="text-muted-foreground">{c.engine} · {c.node_type}</span>
							</div>
						))}
						{components.queues.map((q: any) => (
							<div key={q.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{q.name}</span>
								</div>
								<span className="text-muted-foreground">{q.fifo ? "FIFO" : "Standard"}</span>
							</div>
						))}
						{components.topics.map((t: any) => (
							<div key={t.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{t.name}</span>
								</div>
								<span className="text-muted-foreground">Topic</span>
							</div>
						))}
						{components.nosql_tables.map((d: any) => (
							<div key={d.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<Table className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{d.name}</span>
								</div>
								<span className="text-muted-foreground">{d.hash_key} ({d.billing_mode === "PROVISIONED" ? "Provisioned" : "On-Demand"})</span>
							</div>
						))}
						{components.secrets.map((s: any) => (
							<div key={s.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-xs">
								<div className="flex items-center gap-2">
									<Lock className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="font-mono font-medium">{s.name}</span>
								</div>
								<span className="text-muted-foreground">{s.length} chars{s.generate ? " · Auto" : ""}</span>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{/* Recent Jobs */}
			{jobs.length > 0 && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm">Recent Jobs</CardTitle>
					</CardHeader>
					<CardContent className="space-y-1">
						{jobs.map((job) => {
							const info = JOB_TYPES[job.job_type as keyof typeof JOB_TYPES];
							const Icon = info?.icon;
							return (
								<Link key={job.id} href={`/dashboard/jobs/${job.id}`}>
									<div className="flex items-center justify-between p-2.5 rounded-md hover:bg-muted/30 transition-colors text-xs">
										<div className="flex items-center gap-2">
											{Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
											<span className="font-medium">{info?.label ?? job.job_type}</span>
										</div>
										<div className="flex items-center gap-2">
											<Badge variant="outline" className={`text-[10px] py-0 ${JOB_STATUS_STYLES[job.status] ?? ""}`}>
												{job.status}
											</Badge>
											{job.created_at && (
												<span className="text-muted-foreground">
													{formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
												</span>
											)}
										</div>
									</div>
								</Link>
							);
						})}
					</CardContent>
				</Card>
			)}

			{/* Git Repos */}
			{components.repositories && (components.repositories.env_destination_repo || components.repositories.gitops_destination_repo) && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm">Git Repositories</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						{components.repositories.env_destination_repo && (
							<div className="flex items-center gap-2 text-xs">
								<GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-muted-foreground">Infra:</span>
								<span className="font-mono truncate">{components.repositories.env_destination_repo}</span>
							</div>
						)}
						{components.repositories.gitops_destination_repo && (
							<div className="flex items-center gap-2 text-xs">
								<GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-muted-foreground">GitOps:</span>
								<span className="font-mono truncate">{components.repositories.gitops_destination_repo}</span>
							</div>
						)}
						{components.repositories.apps_destination_repo && (
							<div className="flex items-center gap-2 text-xs">
								<GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-muted-foreground">Apps:</span>
								<span className="font-mono truncate">{components.repositories.apps_destination_repo}</span>
							</div>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
