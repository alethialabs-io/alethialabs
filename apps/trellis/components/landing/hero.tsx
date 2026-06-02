"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { CodeDemo } from "./code-demo";
import { ScrollingLogos } from "./scrolling-logos";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const PROVIDERS = [
	{ id: "aws", name: "AWS", icon: "/aws/favicon_32x32.png" },
	{ id: "gcp", name: "GCP", icon: "/gcp/favicon_32x32.png" },
	{ id: "azure", name: "Azure", icon: "/azure/favicon_32x32.png" },
];

const CAPABILITY_TABS: Record<
	string,
	{
		id: string;
		label: string;
		code: Record<string, { text: string; color?: string }[]>;
		output: Record<string, { text: string; color?: string }[]>;
	}[]
> = {
	all: [
		{
			id: "network",
			label: "Network",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Network ──────────────────────────┐" },
					{ text: "│ ☑ Create new VPC                 │" },
					{ text: "│ CIDR: 10.0.0.0/16               │" },
					{ text: "│ ☑ Single NAT Gateway            │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Network ──────────────────────────┐" },
					{ text: "│ ☑ Create new VPC Network         │" },
					{ text: "│ Auto-create subnets: Yes         │" },
					{ text: "│ Region: us-central1              │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Network ──────────────────────────┐" },
					{ text: "│ ☑ Create new VNet                │" },
					{ text: "│ Address space: 10.0.0.0/16       │" },
					{ text: "│ Region: westeurope               │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_vpc.main           10.0.0.0/16", color: "green" },
					{ text: "✓ aws_subnet.public_a    10.0.1.0/24", color: "green" },
					{ text: "✓ aws_subnet.public_b    10.0.2.0/24", color: "green" },
					{ text: "✓ aws_subnet.private_a   10.0.10.0/24", color: "green" },
					{ text: "✓ aws_nat_gateway.main   elastic IP", color: "green" },
					{ text: "" },
					{ text: "5 resources to create", color: "muted" },
				],
				gcp: [
					{ text: "✓ google_compute_network.main", color: "green" },
					{ text: "✓ google_compute_subnetwork.us_central1", color: "green" },
					{ text: "✓ google_compute_router.main", color: "green" },
					{ text: "✓ google_compute_router_nat.main", color: "green" },
					{ text: "" },
					{ text: "4 resources to create", color: "muted" },
				],
				azure: [
					{ text: "✓ azurerm_virtual_network.main", color: "green" },
					{ text: "✓ azurerm_subnet.default   10.0.1.0/24", color: "green" },
					{ text: "✓ azurerm_subnet.aks       10.0.2.0/24", color: "green" },
					{ text: "✓ azurerm_nat_gateway.main", color: "green" },
					{ text: "" },
					{ text: "4 resources to create", color: "muted" },
				],
			},
		},
		{
			id: "cluster",
			label: "Cluster",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cluster ─────────────────────────┐" },
					{ text: "│ Kubernetes: 1.31                 │" },
					{ text: "│ Instance: m5.large               │" },
					{ text: "│ Nodes: min 2, desired 3, max 10  │" },
					{ text: "│ ☑ Karpenter autoscaling          │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cluster ─────────────────────────┐" },
					{ text: "│ Kubernetes: 1.30                 │" },
					{ text: "│ Machine: e2-standard-4           │" },
					{ text: "│ ☑ GKE Autopilot                 │" },
					{ text: "│ Region: us-central1              │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cluster ─────────────────────────┐" },
					{ text: "│ Kubernetes: 1.30                 │" },
					{ text: "│ VM Size: Standard_D4s_v3         │" },
					{ text: "│ Nodes: min 2, max 10             │" },
					{ text: "│ ☑ Cluster autoscaler             │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_eks_cluster.main      v1.31", color: "green" },
					{ text: "✓ aws_eks_node_group.main   m5.large x3", color: "green" },
					{ text: "✓ helm_release.karpenter    v0.37", color: "green" },
					{ text: "✓ helm_release.argocd       v2.12", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $219/mo", color: "yellow" },
				],
				gcp: [
					{ text: "✓ google_container_cluster.main   v1.30", color: "green" },
					{ text: "✓ google_container_node_pool.main", color: "green" },
					{ text: "✓ helm_release.argocd             v2.12", color: "green" },
					{ text: "" },
					{ text: "  Autopilot manages scaling", color: "muted" },
					{ text: "  Estimated: $195/mo", color: "yellow" },
				],
				azure: [
					{ text: "✓ azurerm_kubernetes_cluster.main  v1.30", color: "green" },
					{ text: "✓ azurerm_kubernetes_node_pool.sys", color: "green" },
					{ text: "✓ helm_release.argocd              v2.12", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $208/mo", color: "yellow" },
				],
			},
		},
		{
			id: "database",
			label: "Database",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Database ────────────────────────┐" },
					{ text: "│ Engine: Aurora PostgreSQL 16.4   │" },
					{ text: "│ Instance: db.r6g.large           │" },
					{ text: "│ Nodes: 2   ☑ Multi-AZ           │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Database ────────────────────────┐" },
					{ text: "│ Engine: Cloud SQL PostgreSQL 16  │" },
					{ text: "│ Tier: db-custom-4-16384          │" },
					{ text: "│ ☑ High availability              │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Database ────────────────────────┐" },
					{ text: "│ Engine: Azure Database for PG 16 │" },
					{ text: "│ SKU: GP_Standard_D4s_v3          │" },
					{ text: "│ ☑ Zone-redundant HA              │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_rds_cluster.main        aurora-postgresql", color: "green" },
					{ text: "✓ aws_rds_instance.writer     db.r6g.large", color: "green" },
					{ text: "✓ aws_rds_instance.reader     db.r6g.large", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $412/mo", color: "yellow" },
				],
				gcp: [
					{ text: "✓ google_sql_database_instance.main", color: "green" },
					{ text: "✓ google_sql_database_instance.replica", color: "green" },
					{ text: "✓ google_sql_database.app", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $380/mo", color: "yellow" },
				],
				azure: [
					{ text: "✓ azurerm_postgresql_flexible_server.main", color: "green" },
					{ text: "  Zone-redundant HA enabled", color: "muted" },
					{ text: "" },
					{ text: "  Estimated: $395/mo", color: "yellow" },
				],
			},
		},
		{
			id: "cache",
			label: "Cache",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cache ───────────────────────────┐" },
					{ text: "│ Engine: ElastiCache Redis        │" },
					{ text: "│ Node: cache.r6g.large            │" },
					{ text: "│ ☑ Multi-AZ                       │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cache ───────────────────────────┐" },
					{ text: "│ Engine: Memorystore for Redis    │" },
					{ text: "│ Tier: Standard                   │" },
					{ text: "│ Capacity: 4 GB                   │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Cache ───────────────────────────┐" },
					{ text: "│ Engine: Azure Cache for Redis    │" },
					{ text: "│ SKU: Premium P1                  │" },
					{ text: "│ ☑ Zone-redundant                 │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_elasticache_cluster.main    redis", color: "green" },
					{ text: "✓ aws_elasticache_subnet_group.main", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $156/mo", color: "yellow" },
				],
				gcp: [
					{ text: "✓ google_redis_instance.main   standard 4GB", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $148/mo", color: "yellow" },
				],
				azure: [
					{ text: "✓ azurerm_redis_cache.main   Premium P1", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $162/mo", color: "yellow" },
				],
			},
		},
		{
			id: "dns",
			label: "DNS",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ DNS ─────────────────────────────┐" },
					{ text: "│ Domain: api.example.com          │" },
					{ text: "│ Zone: example.com (Z1234...)     │" },
					{ text: "│ ☑ ACM Certificate                │" },
					{ text: "│ ☑ CloudFront WAF                 │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ DNS ─────────────────────────────┐" },
					{ text: "│ Domain: api.example.com          │" },
					{ text: "│ Zone: example-com                │" },
					{ text: "│ ☑ Managed Certificate            │" },
					{ text: "│ ☑ Cloud Armor                    │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ DNS ─────────────────────────────┐" },
					{ text: "│ Domain: api.example.com          │" },
					{ text: "│ Zone: example.com                │" },
					{ text: "│ ☑ App Service Certificate        │" },
					{ text: "│ ☑ Azure WAF                      │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_route53_record.main    A → ALB", color: "green" },
					{ text: "✓ aws_acm_certificate.main   *.example.com", color: "green" },
					{ text: "✓ aws_wafv2_web_acl.main", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $7/mo", color: "yellow" },
				],
				gcp: [
					{ text: "✓ google_dns_record_set.main   A", color: "green" },
					{ text: "✓ google_compute_managed_ssl.main", color: "green" },
					{ text: "✓ google_compute_security_policy.main", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $5/mo", color: "yellow" },
				],
				azure: [
					{ text: "✓ azurerm_dns_a_record.main", color: "green" },
					{ text: "✓ azurerm_app_service_certificate.main", color: "green" },
					{ text: "✓ azurerm_web_application_firewall.main", color: "green" },
					{ text: "" },
					{ text: "  Estimated: $8/mo", color: "yellow" },
				],
			},
		},
		{
			id: "secrets",
			label: "Secrets",
			code: {
				aws: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Secrets ─────────────────────────┐" },
					{ text: "│ + DATABASE_URL    ••••••••       │" },
					{ text: "│ + REDIS_URL       ••••••••       │" },
					{ text: "│ + API_KEY         ••••••••       │" },
					{ text: "└──────────────────────────────────┘" },
				],
				gcp: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Secrets ─────────────────────────┐" },
					{ text: "│ + DATABASE_URL    ••••••••       │" },
					{ text: "│ + REDIS_URL       ••••••••       │" },
					{ text: "│ + API_KEY         ••••••••       │" },
					{ text: "└──────────────────────────────────┘" },
				],
				azure: [
					{ text: "grape config create", color: "muted" },
					{ text: "" },
					{ text: "┌ Secrets ─────────────────────────┐" },
					{ text: "│ + DATABASE_URL    ••••••••       │" },
					{ text: "│ + REDIS_URL       ••••••••       │" },
					{ text: "│ + API_KEY         ••••••••       │" },
					{ text: "└──────────────────────────────────┘" },
				],
			},
			output: {
				aws: [
					{ text: "✓ aws_secretsmanager_secret.DATABASE_URL", color: "green" },
					{ text: "✓ aws_secretsmanager_secret.REDIS_URL", color: "green" },
					{ text: "✓ aws_secretsmanager_secret.API_KEY", color: "green" },
					{ text: "" },
					{ text: "  $0.40/secret/mo", color: "yellow" },
				],
				gcp: [
					{ text: "✓ google_secret_manager_secret.DATABASE_URL", color: "green" },
					{ text: "✓ google_secret_manager_secret.REDIS_URL", color: "green" },
					{ text: "✓ google_secret_manager_secret.API_KEY", color: "green" },
					{ text: "" },
					{ text: "  $0.06/10k access ops", color: "yellow" },
				],
				azure: [
					{ text: "✓ azurerm_key_vault_secret.DATABASE_URL", color: "green" },
					{ text: "✓ azurerm_key_vault_secret.REDIS_URL", color: "green" },
					{ text: "✓ azurerm_key_vault_secret.API_KEY", color: "green" },
					{ text: "" },
					{ text: "  $0.03/10k operations", color: "yellow" },
				],
			},
		},
	],
};

const STATS = [
	{ value: "3", label: "Cloud Providers" },
	{ value: "11", label: "Infrastructure Sections" },
	{ value: "16", label: "CLI Commands" },
	{ value: "12", label: "Resource Types" },
];

export function Hero() {
	const [provider, setProvider] = useState("aws");

	const tabs = CAPABILITY_TABS.all.map((cap) => ({
		id: cap.id,
		label: cap.label,
		code: (cap.code[provider] ?? cap.code.aws).map((l) => ({
			text: l.text,
			color: l.color as "green" | "blue" | "yellow" | "muted" | "white" | undefined,
		})),
		output: (cap.output[provider] ?? cap.output.aws).map((l) => ({
			text: l.text,
			color: l.color as "green" | "muted" | "yellow" | "white" | undefined,
		})),
	}));

	return (
		<section className="relative pt-28 pb-12 md:pt-36 md:pb-20">
			<div className="container mx-auto px-4">
				<div className="max-w-[64rem] mx-auto text-center flex flex-col items-center">
					{/* Badge */}
					<Badge
						variant="outline"
						className="mb-6 rounded-full px-3 py-1 text-xs tracking-tight border-border/50"
					>
						Open Source Infrastructure Platform
					</Badge>

					{/* H1 */}
					<h1 className="font-bold text-4xl sm:text-5xl md:text-6xl lg:text-7xl tracking-tighter text-foreground mb-4 leading-[1.05] max-w-[52rem]">
						The infrastructure layer
						<br />
						<span className="text-muted-foreground">
							for cloud-native teams
						</span>
					</h1>

					{/* Subtitle */}
					<p className="text-muted-foreground text-lg sm:text-xl mb-8 max-w-[40rem] mx-auto leading-relaxed">
						Configure multi-cloud Kubernetes infrastructure visually.
						Deploy from the terminal. Zero credentials stored.
					</p>

					{/* Install command */}
					<div className="flex items-center gap-3 rounded-lg border border-border/50 bg-neutral-950 px-4 py-2.5 mb-10">
						<code className="font-mono text-sm text-white/80">
							<span className="text-white/30">$ </span>
							brew install grape
						</code>
						<CopyButton text="brew install grape" />
					</div>

					{/* Code demo */}
					<div className="w-full max-w-[56rem]">
						<CodeDemo
							tabs={tabs}
							providers={PROVIDERS}
							activeProvider={provider}
							onProviderChange={setProvider}
						/>
					</div>

					{/* Scrolling logos */}
					<div className="w-full mt-12">
						<ScrollingLogos />
					</div>

					{/* Stats strip */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-10 w-full max-w-[48rem] mt-8">
						{STATS.map((stat) => (
							<div key={stat.label} className="text-center">
								<p className="text-3xl md:text-4xl font-bold tracking-tighter text-foreground">
									{stat.value}
								</p>
								<p className="text-xs text-muted-foreground mt-1">
									{stat.label}
								</p>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
