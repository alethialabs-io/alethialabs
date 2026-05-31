"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClusterData } from "@/lib/stores/use-clusters-store";
import {
	Check,
	Copy,
	Database,
	ExternalLink,
	Globe,
	HardDrive,
	Server,
} from "lucide-react";
import { useState } from "react";

function CopyBtn({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-5 w-5 shrink-0 opacity-0 group-hover/copy:opacity-100 transition-opacity"
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? (
				<Check className="h-3 w-3 text-emerald-500" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

function InfoRow({
	label,
	value,
	copyable,
	href,
}: {
	label: string;
	value: string;
	copyable?: boolean;
	href?: string;
}) {
	return (
		<div className="group/copy flex items-center justify-between gap-2 py-1.5">
			<span className="text-[11px] text-muted-foreground shrink-0">
				{label}
			</span>
			<div className="flex items-center gap-1.5 min-w-0">
				<code className="text-[11px] font-mono truncate text-foreground">
					{value}
				</code>
				{copyable && <CopyBtn value={value} />}
				{href && (
					<a href={href} target="_blank" rel="noopener noreferrer">
						<ExternalLink className="h-3 w-3 text-muted-foreground hover:text-foreground" />
					</a>
				)}
			</div>
		</div>
	);
}

export function ClusterCard({ cluster }: { cluster: ClusterData }) {
	const kubeconfigCmd = cluster.cluster_name
		? `aws eks update-kubeconfig --name ${cluster.cluster_name} --region ${cluster.region}`
		: null;
	const argoUrl = cluster.dns_domain
		? `https://argocd.${cluster.dns_domain}`
		: null;

	return (
		<div className="rounded-lg border border-border/60 bg-card overflow-hidden">
			<div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div className="p-2 rounded-md bg-emerald-500/10">
						<Server className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
					</div>
					<div>
						<h3 className="text-sm font-medium">
							{cluster.project_name}
						</h3>
						<p className="text-[11px] text-muted-foreground">
							{cluster.environment_stage} &middot;{" "}
							{cluster.region}
						</p>
					</div>
				</div>
				<Badge
					variant="outline"
					className="text-[10px] py-0 text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950"
				>
					Active
				</Badge>
			</div>

			<div className="px-5 py-3 space-y-4">
				{/* EKS Cluster */}
				{cluster.cluster_name && (
					<div className="space-y-1">
						<div className="flex items-center gap-1.5 mb-2">
							<Globe className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">
								EKS Cluster
							</span>
							{cluster.cluster_version && (
								<Badge
									variant="outline"
									className="text-[9px] py-0 ml-1"
								>
									v{cluster.cluster_version}
								</Badge>
							)}
						</div>
						<InfoRow
							label="Name"
							value={cluster.cluster_name}
							copyable
						/>
						{cluster.cluster_endpoint && (
							<InfoRow
								label="Endpoint"
								value={cluster.cluster_endpoint}
								copyable
							/>
						)}
						{kubeconfigCmd && (
							<InfoRow
								label="kubeconfig"
								value={kubeconfigCmd}
								copyable
							/>
						)}
						{argoUrl && (
							<InfoRow
								label="ArgoCD"
								value={argoUrl}
								copyable
								href={argoUrl}
							/>
						)}
					</div>
				)}

				{/* Databases */}
				{cluster.databases.length > 0 && (
					<div className="space-y-1 pt-2 border-t border-border/30">
						<div className="flex items-center gap-1.5 mb-2">
							<Database className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">
								Databases
							</span>
						</div>
						{cluster.databases.map((db) => (
							<div key={db.name} className="space-y-0.5">
								<div className="flex items-center gap-2">
									<span className="text-[11px] font-medium">
										{db.name}
									</span>
									<Badge
										variant="outline"
										className="text-[9px] py-0"
									>
										{db.engine}
									</Badge>
								</div>
								{db.endpoint && (
									<InfoRow
										label="Endpoint"
										value={db.endpoint}
										copyable
									/>
								)}
							</div>
						))}
					</div>
				)}

				{/* Caches */}
				{cluster.caches.length > 0 && (
					<div className="space-y-1 pt-2 border-t border-border/30">
						<div className="flex items-center gap-1.5 mb-2">
							<HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">Caches</span>
						</div>
						{cluster.caches.map((cache) => (
							<div key={cache.name} className="space-y-0.5">
								<div className="flex items-center gap-2">
									<span className="text-[11px] font-medium">
										{cache.name}
									</span>
									<Badge
										variant="outline"
										className="text-[9px] py-0"
									>
										{cache.engine}
									</Badge>
								</div>
								{cache.endpoint && (
									<InfoRow
										label="Endpoint"
										value={cache.endpoint}
										copyable
									/>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
