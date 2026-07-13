"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type { ClusterData } from "@/app/server/actions/clusters";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	Check,
	Copy,
	Database,
	ExternalLink,
	HardDrive,
	Server,
	Terminal,
} from "lucide-react";
import { useState } from "react";

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-6 w-6 shrink-0"
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? (
				<Check className="h-3 w-3 text-foreground" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

export function ClusterCard({
	data,
	initialAssignments,
}: {
	data: ClusterData;
	initialAssignments?: AssignedValue[];
}) {
	const provider = data.cloud_identities?.provider ?? "aws";
	const meta = getProvider(provider as CloudProviderSlug);
	const cluster = Array.isArray(data.project_cluster) ? data.project_cluster[0] : data.project_cluster;
	const databases = data.project_databases ?? [];
	const caches = data.project_caches ?? [];

	const kubeconfigCmd = cluster?.cluster_name
		? `aws eks update-kubeconfig --name ${cluster.cluster_name} --region ${data.region}`
		: null;

	// The ArgoCD admin password is never stored (it would be plaintext in our DB); it is
	// retrieved on-demand from the cluster's argocd-initial-admin-secret. Show the command.
	const argocdPasswordCmd =
		"kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";

	return (
		<div className="rounded-lg border border-border/50 bg-card p-5 space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<ProviderIcon provider={provider} size={20} />
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">
								{data.project_name}
							</h3>
							<StatusBadge status="active" label="Active" />
						</div>
						<p className="text-[11px] text-muted-foreground">
							{meta.shortName} · {data.region} ·{" "}
							{data.environment_stage}
							{cluster?.cluster_version
								? ` · K8s ${cluster.cluster_version}`
								: ""}
						</p>
						{/* Classification (Workstream B) — chips + a picker for org editors. */}
						{cluster?.id && (
							<ClassificationControl
								kind="project_cluster"
								id={cluster.id}
								canEdit
								initialAssignments={initialAssignments}
								className="mt-1.5"
								compact
							/>
						)}
					</div>
				</div>
			</div>

			{/* Cluster access */}
			{cluster?.cluster_endpoint && (
				<div className="space-y-2">
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<Terminal className="h-3.5 w-3.5" />
						<span className="text-[11px] font-medium">
							Cluster Access
						</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-[11px] bg-muted px-2 py-1 rounded font-mono truncate border border-border/50">
							{cluster.cluster_endpoint}
						</code>
						<CopyButton value={cluster.cluster_endpoint} />
					</div>
					{kubeconfigCmd && (
						<div className="flex items-center gap-2">
							<code className="flex-1 text-[11px] bg-muted px-2 py-1 rounded font-mono truncate border border-border/50">
								{kubeconfigCmd}
							</code>
							<CopyButton value={kubeconfigCmd} />
						</div>
					)}
				</div>
			)}

			{/* ArgoCD */}
			{cluster?.argocd_url && (
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5 text-muted-foreground">
						<Server className="h-3.5 w-3.5" />
						<span className="text-[11px] font-medium">ArgoCD</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-[11px] bg-muted px-2 py-1 rounded font-mono truncate border border-border/50">
							{cluster.argocd_url}
						</code>
						<a
							href={cluster.argocd_url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0"
							>
								<ExternalLink className="h-3 w-3" />
							</Button>
						</a>
					</div>
					{/* Admin password is retrieved on-demand from the cluster, never stored. */}
					<p className="text-[10px] text-muted-foreground">
						Admin password (retrieve from the cluster):
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-[11px] bg-muted px-2 py-1 rounded font-mono truncate border border-border/50">
							{argocdPasswordCmd}
						</code>
						<CopyButton value={argocdPasswordCmd} />
					</div>
				</div>
			)}

			{/* Services */}
			{(databases.length > 0 || caches.length > 0) && (
				<div className="space-y-2 pt-1 border-t border-border/30">
					{databases.map((db) => (
						<div
							key={db.name}
							className="flex items-center justify-between"
						>
							<div className="flex items-center gap-2">
								<Database className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-xs font-medium">
									{db.name}
								</span>
								<span className="text-[10px] text-muted-foreground">
									{db.engine}
								</span>
							</div>
							{db.endpoint && (
								<div className="flex items-center gap-1">
									<code className="text-[10px] text-muted-foreground font-mono max-w-[200px] truncate">
										{db.endpoint}
									</code>
									<CopyButton value={db.endpoint} />
								</div>
							)}
						</div>
					))}
					{caches.map((cache) => (
						<div
							key={cache.name}
							className="flex items-center justify-between"
						>
							<div className="flex items-center gap-2">
								<HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="text-xs font-medium">
									{cache.name}
								</span>
								<span className="text-[10px] text-muted-foreground">
									{cache.engine}
								</span>
							</div>
							{cache.endpoint && (
								<div className="flex items-center gap-1">
									<code className="text-[10px] text-muted-foreground font-mono max-w-[200px] truncate">
										{cache.endpoint}
									</code>
									<CopyButton value={cache.endpoint} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
