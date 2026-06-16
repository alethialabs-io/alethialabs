"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type { CloudProviderMeta } from "@/lib/cloud-providers";
import { GitBranch, Globe, Network, Server, Settings2, type LucideIcon } from "lucide-react";

interface InfrastructureTabProps {
	vine: { region: string; terraform_version: string; environment_stage: string };
	components: {
		network: {
			provision_network: boolean | null;
			cidr_block: string | null;
			single_nat_gateway: boolean | null;
			network_id: string | null;
		} | null;
		cluster: {
			cluster_version: string | null;
			node_min_size: number | null;
			node_max_size: number | null;
			node_desired_size: number | null;
			instance_types: string[] | null;
			cluster_admins: unknown[] | null;
		} | null;
		dns: {
			enabled: boolean | null;
			domain_name: string | null;
			zone_id: string | null;
			managed_certificate: boolean | null;
			waf_enabled: boolean | null;
		} | null;
		repositories: {
			apps_destination_repo: string | null;
		} | null;
	};
	providerMeta: CloudProviderMeta;
}

function InfraRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 px-4 py-3">
			<Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
			<span className="text-xs font-medium text-muted-foreground w-28 shrink-0">{label}</span>
			<span className="text-xs text-foreground font-mono truncate">{children}</span>
		</div>
	);
}

export function InfrastructureTab({ vine, components, providerMeta }: InfrastructureTabProps) {
	const { network, cluster, dns, repositories } = components;

	const repoSummary = [
		repositories?.apps_destination_repo && `apps: ${repositories.apps_destination_repo}`,
	].filter(Boolean).join(" · ");

	return (
		<div className="rounded-lg border divide-y">
			{network && (
				<InfraRow icon={Network} label={providerMeta.networkName}>
					{network.provision_network ? "Create New" : "Existing"} · {network.cidr_block ?? "—"} · {network.single_nat_gateway ? "Single NAT" : "NAT per AZ"}
				</InfraRow>
			)}
			{cluster && (
				<InfraRow icon={Server} label={`${providerMeta.clusterService} Cluster`}>
					v{cluster.cluster_version ?? "?"} · {cluster.node_min_size ?? "?"}-{cluster.node_max_size ?? "?"} nodes · {cluster.instance_types?.join(", ") ?? "—"}
				</InfraRow>
			)}
			{dns?.enabled && (
				<InfraRow icon={Globe} label={providerMeta.dnsService}>
					{dns.domain_name ?? "—"} · {dns.zone_id ?? "—"} · Cert {dns.managed_certificate ? "✓" : "✗"} · WAF {dns.waf_enabled ? "✓" : "✗"}
				</InfraRow>
			)}
			{repoSummary && (
				<InfraRow icon={GitBranch} label="Repositories">
					{repoSummary}
				</InfraRow>
			)}
			<InfraRow icon={Settings2} label="General">
				Terraform v{vine.terraform_version} · {vine.region} · {vine.environment_stage}
			</InfraRow>
		</div>
	);
}
