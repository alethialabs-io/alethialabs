"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useProviderMeta, useProviderSlug, DB_CAPACITY } from "@/lib/cloud-providers";
import { Badge } from "@repo/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/ui/card";
import { Separator } from "@repo/ui/separator";
import {
	Bell,
	Cloud,
	Database,
	GitBranch,
	Globe,
	Lock,
	MessageSquare,
	Server,
	Table,
	Zap,
	type LucideIcon,
} from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

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

function FeaturePill({ label, enabled }: { label: string; enabled: boolean }) {
	return (
		<Badge variant="outline" className={`text-[10px] ${enabled ? "bg-muted border-border text-foreground" : "bg-muted/30 border-border/40 text-muted-foreground opacity-60"}`}>
			{enabled ? "On" : "Off"} {label}
		</Badge>
	);
}

/** Review tab — mirrors the overview-tab display style for pre-creation review. */
export function ReviewTab() {
	const { watch } = useFormContext<ProjectFormData>();
	const meta = useProviderMeta();
	const provider = useProviderSlug();
	const capacity = DB_CAPACITY[provider];

	const project = watch("project");
	const network = watch("network");
	const cluster = watch("cluster");
	const dns = watch("dns");
	const repositories = watch("repositories");
	const databases = watch("databases") || [];
	const caches = watch("caches") || [];
	const queues = watch("queues") || [];
	const topics = watch("topics") || [];
	const nosqlTables = watch("nosql_tables") || [];
	const secrets = watch("secrets") || [];

	const instanceTypes = (cluster.instance_types || []) as string[];

	return (
		<div className="space-y-5">
			{/* Configuration Summary */}
			<Card className="border border-border shadow-sm">
				<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
					<CardTitle className="text-lg font-semibold tracking-tight">Configuration Summary</CardTitle>
					<CardDescription>
						Review your infrastructure configuration before creating.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-6 space-y-5">
					{/* Basics */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<Field label="Project Name" value={project.project_name} mono />
						<Field label="Environment" value={project.environment_stage} />
						<Field label="Region" value={project.region} mono />
						<Field label="Provider" value={meta.shortName} />
					</div>

					{/* Network */}
					<Separator />
					<div>
						<SectionTitle icon={Cloud} title={`${meta.networkName} & Networking`} />
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
							<Field label="Mode" value={network.provision_network ? "Create New" : "Use Existing"} />
							{network.provision_network && <Field label="CIDR Block" value={network.cidr_block} mono />}
							{!network.provision_network && network.network_id && <Field label="Network ID" value={network.network_id} mono />}
							<Field label="NAT" value={network.single_nat_gateway ? "Single" : "Per AZ"} />
						</div>
					</div>

					{/* Cluster */}
					<Separator />
					<div>
						<SectionTitle icon={Server} title={`${meta.clusterService} Cluster`} />
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
							<Field label="Cluster Version" value={`v${cluster.cluster_version}`} mono />
							<Field label="Min Nodes" value={cluster.node_min_size} />
							<Field label="Desired Nodes" value={cluster.node_desired_size} />
							<Field label="Max Nodes" value={cluster.node_max_size} />
						</div>
						<div className="flex flex-wrap gap-1.5 mb-2">
							{instanceTypes.map((t) => (
								<Badge key={t} variant="outline" className="text-[10px] font-mono bg-muted/30">{t}</Badge>
							))}
						</div>
					</div>

					{/* DNS */}
					{dns.enabled && (
						<>
							<Separator />
							<div>
								<SectionTitle icon={Globe} title="DNS & Security" />
								<div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-3">
									<Field label="Domain" value={dns.domain_name} mono />
									<Field label="DNS Zone" value={dns.zone_id} mono />
								</div>
								<div className="flex flex-wrap gap-2">
									<FeaturePill label="Managed Certificate" enabled={!!dns.managed_certificate} />
									<FeaturePill label="WAF" enabled={!!dns.waf_enabled} />
								</div>
							</div>
						</>
					)}

					{/* Repositories */}
					{repositories.apps_destination_repo && (
						<>
							<Separator />
							<div>
								<SectionTitle icon={GitBranch} title="Application Repository" />
								<div className="grid grid-cols-1 gap-2">
									<Field label="App Deployment Repo" value={repositories.apps_destination_repo} mono />
								</div>
							</div>
						</>
					)}
				</CardContent>
			</Card>

			{/* Services & Components */}
			{(databases.length > 0 || caches.length > 0 || queues.length > 0 || topics.length > 0 || nosqlTables.length > 0 || secrets.length > 0) && (
				<Card className="border border-border shadow-sm">
					<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
						<CardTitle className="text-lg font-semibold tracking-tight">Services & Components</CardTitle>
						<CardDescription>Additional infrastructure resources</CardDescription>
					</CardHeader>
					<CardContent className="pt-6 space-y-5">
						{/* Databases */}
						{databases.length > 0 && (
							<div>
								<SectionTitle icon={Database} title="Databases" />
								<div className="space-y-3">
									{databases.map((db, i) => (
										<div key={i} className="p-3 rounded-md border bg-background">
											<div className="flex items-center justify-between mb-2">
												<span className="text-sm font-medium font-mono">{db.name || "Unnamed"}</span>
												<Badge variant="outline" className="text-[10px] bg-muted/30">{db.engine}</Badge>
											</div>
											<div className="grid grid-cols-3 gap-3 text-xs">
												<div><span className="text-muted-foreground">Min {capacity.unit}</span><p className="font-medium">{db.min_capacity}</p></div>
												<div><span className="text-muted-foreground">Max {capacity.unit}</span><p className="font-medium">{db.max_capacity}</p></div>
												<div><span className="text-muted-foreground">IAM Auth</span><p className="font-medium">{db.iam_auth ? "Yes" : "No"}</p></div>
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Caches */}
						{caches.length > 0 && (
							<>
								{databases.length > 0 && <Separator />}
								<div>
									<SectionTitle icon={Zap} title="Caches" />
									<div className="space-y-3">
										{caches.map((c, i) => (
											<div key={i} className="p-3 rounded-md border bg-background">
												<div className="flex items-center justify-between mb-2">
													<span className="text-sm font-medium font-mono">{c.name || "Unnamed"}</span>
													<Badge variant="outline" className="text-[10px] bg-muted/30">{c.engine}</Badge>
												</div>
												<div className="grid grid-cols-3 gap-3 text-xs">
													<div><span className="text-muted-foreground">Node Type</span><p className="font-medium font-mono">{c.node_type}</p></div>
													<div><span className="text-muted-foreground">Nodes</span><p className="font-medium">{c.num_cache_nodes}</p></div>
													<div><span className="text-muted-foreground">Multi-AZ</span><p className="font-medium">{c.multi_az ? "Yes" : "No"}</p></div>
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* Queues */}
						{queues.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={MessageSquare} title={`${meta.queueService} Queues`} />
									<div className="space-y-2">
										{queues.map((q, i) => (
											<div key={i} className="flex items-center justify-between p-3 rounded-md border bg-background">
												<span className="text-sm font-medium font-mono">{q.name || "Unnamed"}</span>
												<div className="flex gap-2">
													{q.ordered && <Badge variant="outline" className="text-[10px] bg-muted/30">FIFO</Badge>}
													<span className="text-xs text-muted-foreground">{q.visibility_timeout}s timeout</span>
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* Topics */}
						{topics.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={Bell} title={`${meta.topicService} Topics`} />
									<div className="space-y-2">
										{topics.map((t, i) => (
											<div key={i} className="flex items-center justify-between p-3 rounded-md border bg-background">
												<span className="text-sm font-medium font-mono">{t.name || "Unnamed"}</span>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* NoSQL */}
						{nosqlTables.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={Table} title={`${meta.nosqlService} Tables`} />
									<div className="space-y-3">
										{nosqlTables.map((d, i) => (
											<div key={i} className="p-3 rounded-md border bg-background">
												<div className="flex items-center justify-between mb-2">
													<span className="text-sm font-medium font-mono">{d.name || "Unnamed"}</span>
													<Badge variant="outline" className="text-[10px] bg-muted/30">
														{d.capacity_mode === "provisioned" ? "Provisioned" : "On-Demand"}
													</Badge>
												</div>
												<div className="grid grid-cols-3 gap-3 text-xs">
													<div><span className="text-muted-foreground">Hash Key</span><p className="font-medium font-mono">{d.partition_key} ({d.partition_key_type})</p></div>
													{d.sort_key && <div><span className="text-muted-foreground">Range Key</span><p className="font-medium font-mono">{d.sort_key}</p></div>}
													<div><span className="text-muted-foreground">PITR</span><p className="font-medium">{d.point_in_time_recovery ? "Yes" : "No"}</p></div>
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* Secrets */}
						{secrets.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={Lock} title="Secrets" />
									<div className="space-y-2">
										{secrets.map((s, i) => (
											<div key={i} className="flex items-center justify-between p-3 rounded-md border bg-background">
												<span className="text-sm font-medium font-mono">{s.name || "Unnamed"}</span>
												<div className="flex gap-2 items-center">
													<span className="text-xs text-muted-foreground">{s.length} chars</span>
													{s.special_chars && <Badge variant="outline" className="text-[10px] bg-muted/30">Special</Badge>}
													{s.generate && <Badge variant="outline" className="text-[10px] bg-muted/30">Auto</Badge>}
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
