"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";

interface ClusterAccessProps {
	clusterName: string | null;
	clusterEndpoint: string | null;
	region: string;
	dnsDomain: string | null;
}

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

export function ClusterAccess({
	clusterName,
	clusterEndpoint,
	region,
	dnsDomain,
}: ClusterAccessProps) {
	if (!clusterName && !clusterEndpoint) {
		return null;
	}

	const kubeconfigCmd = `aws eks update-kubeconfig --name ${clusterName} --region ${region}`;
	const argocdUrl = dnsDomain ? `https://argocd.${dnsDomain}` : null;

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Terminal className="h-4 w-4 text-muted-foreground" />
				<h3 className="text-sm font-medium">Cluster Access</h3>
				<StatusBadge status="active" label="Active" />
			</div>

			<div className="space-y-3">
				{clusterEndpoint && (
					<div className="space-y-1">
						<p className="text-[11px] text-muted-foreground font-medium">
							API Endpoint
						</p>
						<div className="flex items-center gap-2">
							<code className="flex-1 text-xs bg-muted px-2.5 py-1.5 rounded-md font-mono truncate border border-border/50">
								{clusterEndpoint}
							</code>
							<CopyButton value={clusterEndpoint} />
						</div>
					</div>
				)}

				{clusterName && (
					<div className="space-y-1">
						<p className="text-[11px] text-muted-foreground font-medium">
							Connect to cluster
						</p>
						<div className="flex items-center gap-2">
							<code className="flex-1 text-xs bg-muted px-2.5 py-1.5 rounded-md font-mono truncate border border-border/50">
								{kubeconfigCmd}
							</code>
							<CopyButton value={kubeconfigCmd} />
						</div>
					</div>
				)}

				{argocdUrl && (
					<div className="space-y-1">
						<p className="text-[11px] text-muted-foreground font-medium">
							ArgoCD Dashboard
						</p>
						<div className="flex items-center gap-2">
							<code className="flex-1 text-xs bg-muted px-2.5 py-1.5 rounded-md font-mono truncate border border-border/50">
								{argocdUrl}
							</code>
							<a
								href={argocdUrl}
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
					</div>
				)}
			</div>
		</div>
	);
}
