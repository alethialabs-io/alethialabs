"use client";

import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { getVine } from "@/app/server/actions/vines";
import { getProvider, DB_CAPACITY, type CloudProviderSlug } from "@/lib/cloud-providers";
import {
	Bell,
	Cloud,
	Database,
	GitBranch,
	Globe,
	Key,
	Lock,
	MessageSquare,
	Network,
	Server,
	Shield,
	Table,
	Zap,
	type LucideIcon,
} from "lucide-react";

type VineDetail = Awaited<ReturnType<typeof getVine>>;

interface OverviewTabProps {
	detail: VineDetail;
}

function SectionTitle({
	icon: Icon,
	title,
}: {
	icon: LucideIcon;
	title: string;
}) {
	return (
		<div className="flex items-center gap-2 mb-3">
			<Icon className="h-4 w-4 text-muted-foreground" />
			<h4 className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
				{title}
			</h4>
		</div>
	);
}

function Field({
	label,
	value,
	mono,
}: {
	label: string;
	value: string | number | null | undefined;
	mono?: boolean;
}) {
	return (
		<div>
			<p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
			<p className={`text-sm font-medium ${mono ? "font-mono" : ""}`}>
				{value ?? "—"}
			</p>
		</div>
	);
}

function FeaturePill({
	label,
	enabled,
}: {
	label: string;
	enabled: boolean;
}) {
	return (
		<Badge
			variant="outline"
			className={`text-[10px] ${
				enabled
					? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
					: "bg-muted/30 border-border/40 text-muted-foreground opacity-60"
			}`}
		>
			{enabled ? "On" : "Off"} {label}
		</Badge>
	);
}

export function OverviewTab({ detail }: OverviewTabProps) {
	const { vine, components } = detail;
	const providerSlug = (detail.cloudProvider || "aws") as CloudProviderSlug;
	const meta = getProvider(providerSlug);
	const capacity = DB_CAPACITY[providerSlug];

	return (
		<div className="space-y-5">
			{/* Project Basics */}
			<Card className="border border-border shadow-sm">
				<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
					<CardTitle className="text-lg font-semibold tracking-tight">
						Configuration Summary
					</CardTitle>
					<CardDescription>
						Infrastructure configuration for{" "}
						<span className="font-mono font-medium text-foreground">
							{vine.project_name}
						</span>
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-6 space-y-5">
					{/* Basics */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						<Field
							label="Project Name"
							value={vine.project_name}
							mono
						/>
						<Field
							label="Environment"
							value={vine.environment_stage}
						/>
						<Field label="Region" value={vine.region} mono />
						<Field
							label="Terraform"
							value={`v${vine.terraform_version}`}
							mono
						/>
					</div>

					{/* VPC */}
					{components.network && (
						<>
							<Separator />
							<div>
								<SectionTitle icon={Cloud} title={`${meta.networkName} & Networking`} />
								<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
									<Field
										label="Mode"
										value={
											components.network?.provision_network
												? "Create New"
												: "Use Existing"
										}
									/>
									{components.network?.cidr_block && (
										<Field
											label="CIDR Block"
											value={components.network?.cidr_block}
											mono
										/>
									)}
									{components.network?.network_id && (
										<Field
											label="VPC ID"
											value={components.network?.network_id}
											mono
										/>
									)}
									<Field
										label="NAT Gateway"
										value={
											components.network?.single_nat_gateway
												? "Single"
												: "Per AZ"
										}
									/>
								</div>
							</div>
						</>
					)}

					{/* EKS */}
					{components.cluster && (
						<>
							<Separator />
							<div>
								<SectionTitle icon={Server} title={`${meta.clusterService} Cluster`} />
								<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
									<Field
										label="Cluster Version"
										value={`v${components.cluster?.cluster_version}`}
										mono
									/>
									<Field
										label="Min Nodes"
										value={components.cluster?.node_min_size}
									/>
									<Field
										label="Desired Nodes"
										value={components.cluster?.node_desired_size}
									/>
									<Field
										label="Max Nodes"
										value={components.cluster?.node_max_size}
									/>
								</div>
								<div className="flex flex-wrap gap-1.5 mb-2">
									{(
										(components.cluster?.instance_types as string[]) ||
										[]
									).map((t) => (
										<Badge
											key={t}
											variant="outline"
											className="text-[10px] font-mono bg-muted/30"
										>
											{t}
										</Badge>
									))}
								</div>
								<div className="flex gap-2">
									<FeaturePill
										label="Karpenter"
										enabled={
											!!components.cluster?.provider_config?.enable_karpenter
										}
									/>
								</div>
							</div>
						</>
					)}

					{/* DNS */}
					{components.dns && (
						<>
							<Separator />
							<div>
								<SectionTitle icon={Globe} title="DNS & CDN" />
								{components.dns.enabled ? (
									<>
										<div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-3">
											<Field
												label="Domain"
												value={
													components.dns.domain_name
												}
												mono
											/>
											<Field
												label="DNS Zone"
												value={
													components.dns
														.zone_id
												}
												mono
											/>
										</div>
										<div className="flex flex-wrap gap-2">
											<FeaturePill
												label="Managed Certificate"
												enabled={
													!!components.dns
														.provider_config?.acm_certificate
												}
											/>
											<FeaturePill
												label="CDN WAF"
												enabled={
													!!components.dns
														.provider_config?.cloudfront_waf
												}
											/>
											<FeaturePill
												label="Application WAF"
												enabled={
													!!components.dns
														.provider_config?.application_waf
												}
											/>
										</div>
									</>
								) : (
									<p className="text-xs text-muted-foreground">
										DNS not enabled
									</p>
								)}
							</div>
						</>
					)}

					{/* Repositories */}
					{components.repositories && (
						<>
							<Separator />
							<div>
								<SectionTitle
									icon={GitBranch}
									title="Git Repositories"
								/>
								<div className="grid grid-cols-1 gap-2">
									{components.repositories
										.env_destination_repo && (
										<Field
											label="Environment Repo"
											value={
												components.repositories
													.env_destination_repo
											}
											mono
										/>
									)}
									{components.repositories
										.gitops_destination_repo && (
										<Field
											label="GitOps Repo"
											value={
												components.repositories
													.gitops_destination_repo
											}
											mono
										/>
									)}
									{components.repositories
										.apps_destination_repo && (
										<Field
											label="Applications Repo"
											value={
												components.repositories
													.apps_destination_repo
											}
											mono
										/>
									)}
								</div>
							</div>
						</>
					)}
				</CardContent>
			</Card>

			{/* 1:N Components */}
			{(components.databases.length > 0 ||
				components.caches.length > 0 ||
				components.queues.length > 0 ||
				components.topics.length > 0 ||
				components.nosql_tables.length > 0 ||
				components.secrets.length > 0) && (
				<Card className="border border-border shadow-sm">
					<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
						<CardTitle className="text-lg font-semibold tracking-tight">
							Services & Components
						</CardTitle>
						<CardDescription>
							Additional infrastructure resources
						</CardDescription>
					</CardHeader>
					<CardContent className="pt-6 space-y-5">
						{/* Databases */}
						{components.databases.length > 0 && (
							<div>
								<SectionTitle icon={Database} title="Databases" />
								<div className="space-y-3">
									{components.databases.map((db: any) => (
										<div
											key={db.id}
											className="p-3 rounded-md border bg-background"
										>
											<div className="flex items-center justify-between mb-2">
												<span className="text-sm font-medium font-mono">
													{db.name}
												</span>
												<Badge
													variant="outline"
													className="text-[10px] bg-muted/30"
												>
													{db.engine}
												</Badge>
											</div>
											<div className="grid grid-cols-3 gap-3 text-xs">
												<div>
													<span className="text-muted-foreground">
														Min {capacity.unit}
													</span>
													<p className="font-medium">
														{db.min_capacity}
													</p>
												</div>
												<div>
													<span className="text-muted-foreground">
														Max {capacity.unit}
													</span>
													<p className="font-medium">
														{db.max_capacity}
													</p>
												</div>
												<div>
													<span className="text-muted-foreground">
														IAM Auth
													</span>
													<p className="font-medium">
														{db.iam_auth
															? "Yes"
															: "No"}
													</p>
												</div>
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Caches */}
						{components.caches.length > 0 && (
							<>
								{components.databases.length > 0 && (
									<Separator />
								)}
								<div>
									<SectionTitle icon={Zap} title="Caches" />
									<div className="space-y-3">
										{components.caches.map((c: any) => (
											<div
												key={c.id}
												className="p-3 rounded-md border bg-background"
											>
												<div className="flex items-center justify-between mb-2">
													<span className="text-sm font-medium font-mono">
														{c.name}
													</span>
													<Badge
														variant="outline"
														className="text-[10px] bg-muted/30"
													>
														{c.engine}
													</Badge>
												</div>
												<div className="grid grid-cols-3 gap-3 text-xs">
													<div>
														<span className="text-muted-foreground">
															Node Type
														</span>
														<p className="font-medium font-mono">
															{c.node_type}
														</p>
													</div>
													<div>
														<span className="text-muted-foreground">
															Nodes
														</span>
														<p className="font-medium">
															{c.num_cache_nodes}
														</p>
													</div>
													<div>
														<span className="text-muted-foreground">
															Multi-AZ
														</span>
														<p className="font-medium">
															{c.multi_az
																? "Yes"
																: "No"}
														</p>
													</div>
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* Queues */}
						{components.queues.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle
										icon={MessageSquare}
										title={`${meta.queueService} Queues`}
									/>
									<div className="space-y-2">
										{components.queues.map((q: any) => (
											<div
												key={q.id}
												className="flex items-center justify-between p-3 rounded-md border bg-background"
											>
												<span className="text-sm font-medium font-mono">
													{q.name}
												</span>
												<div className="flex gap-2">
													{q.fifo && (
														<Badge
															variant="outline"
															className="text-[10px] bg-muted/30"
														>
															FIFO
														</Badge>
													)}
													<span className="text-xs text-muted-foreground">
														{q.visibility_timeout}s
														timeout
													</span>
												</div>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* Topics */}
						{components.topics.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={Bell} title={`${meta.topicService} Topics`} />
									<div className="space-y-2">
										{components.topics.map((t: any) => (
											<div
												key={t.id}
												className="flex items-center justify-between p-3 rounded-md border bg-background"
											>
												<span className="text-sm font-medium font-mono">
													{t.name}
												</span>
											</div>
										))}
									</div>
								</div>
							</>
						)}

						{/* DynamoDB */}
						{components.nosql_tables.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle
										icon={Table}
										title={`${meta.nosqlService} Tables`}
									/>
									<div className="space-y-3">
										{components.nosql_tables.map(
											(d: any) => (
												<div
													key={d.id}
													className="p-3 rounded-md border bg-background"
												>
													<div className="flex items-center justify-between mb-2">
														<span className="text-sm font-medium font-mono">
															{d.name}
														</span>
														<Badge
															variant="outline"
															className="text-[10px] bg-muted/30"
														>
															{d.billing_mode ===
															"PROVISIONED"
																? "Provisioned"
																: "On-Demand"}
														</Badge>
													</div>
													<div className="grid grid-cols-3 gap-3 text-xs">
														<div>
															<span className="text-muted-foreground">
																Hash Key
															</span>
															<p className="font-medium font-mono">
																{d.hash_key} (
																{d.hash_key_type}
																)
															</p>
														</div>
														{d.range_key && (
															<div>
																<span className="text-muted-foreground">
																	Range Key
																</span>
																<p className="font-medium font-mono">
																	{
																		d.range_key
																	}
																</p>
															</div>
														)}
														<div>
															<span className="text-muted-foreground">
																PITR
															</span>
															<p className="font-medium">
																{d.point_in_time_recovery
																	? "Yes"
																	: "No"}
															</p>
														</div>
													</div>
												</div>
											),
										)}
									</div>
								</div>
							</>
						)}

						{/* Secrets */}
						{components.secrets.length > 0 && (
							<>
								<Separator />
								<div>
									<SectionTitle icon={Lock} title="Secrets" />
									<div className="space-y-2">
										{components.secrets.map((s: any) => (
											<div
												key={s.id}
												className="flex items-center justify-between p-3 rounded-md border bg-background"
											>
												<span className="text-sm font-medium font-mono">
													{s.name}
												</span>
												<div className="flex gap-2 items-center">
													<span className="text-xs text-muted-foreground">
														{s.length} chars
													</span>
													{s.special_chars && (
														<Badge
															variant="outline"
															className="text-[10px] bg-muted/30"
														>
															Special
														</Badge>
													)}
													{s.generate && (
														<Badge
															variant="outline"
															className="text-[10px] bg-muted/30"
														>
															Auto
														</Badge>
													)}
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
