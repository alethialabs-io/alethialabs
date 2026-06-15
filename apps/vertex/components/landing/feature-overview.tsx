"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { CodeDemo } from "./code-demo";
import {
	ArrowRight,
	GitBranch,
	Layout,
	Shield,
	Terminal,
	Globe,
} from "lucide-react";
import Link from "next/link";

const BULLETS = [
	{
		icon: Layout,
		title: "Visual Configuration",
		description:
			"11-section guided form with real-time cost estimation. Network, cluster, databases, caches, messaging, DNS, secrets, and more.",
	},
	{
		icon: Shield,
		title: "Zero-Credential Security",
		description:
			"Cross-account IAM roles, Workload Identity Federation, federated identity — no static keys ever stored.",
	},
	{
		icon: GitBranch,
		title: "GitOps by Default",
		description:
			"ArgoCD bootstrapped automatically on every cluster. Git is the audit trail. Plan-review-apply for every change.",
	},
];

const DEMO_TABS = [
	{
		id: "config",
		label: "Config Create",
		code: [
			{ text: "$ grape config create", color: "muted" as const },
			{ text: "" },
			{ text: "  Step 1/6: Vineyard & Basics" },
			{ text: '    Vineyard:    production', color: "green" as const },
			{ text: "    Name:        api-backend", color: "green" as const },
			{ text: "    Environment: production", color: "green" as const },
			{ text: "    Region:      eu-west-1", color: "green" as const },
			{ text: "" },
			{ text: "  Step 2/6: Platform" },
			{ text: "    Kubernetes:  1.31", color: "green" as const },
			{ text: "    Instance:    m5.large", color: "green" as const },
			{ text: "    Nodes:       min 2, max 10", color: "green" as const },
		],
		output: [
			{ text: "✓ Configuration validated", color: "green" as const },
			{ text: "" },
			{ text: "  Vineyard: production" },
			{ text: "  Project:  api-backend" },
			{ text: "  Provider: AWS (eu-west-1)" },
			{ text: "" },
			{ text: "  Components:" },
			{ text: "    VPC, EKS, Aurora, ElastiCache," },
			{ text: "    Route53, Secrets Manager, ECR" },
			{ text: "" },
			{ text: "  Estimated: $847.23/mo", color: "yellow" as const },
		],
	},
	{
		id: "plan",
		label: "Plan & Apply",
		code: [
			{ text: "$ grape harvest", color: "muted" as const },
			{ text: "" },
			{ text: "  ? Select vineyard: production" },
			{ text: "  ? Select vine: api-backend" },
			{ text: "  ? Select worker: prod-worker (ONLINE)" },
			{ text: "" },
			{ text: "  ▸ Terraform init..." },
			{ text: "  ▸ Terraform plan..." },
			{ text: "" },
			{ text: "  47 resources to add", color: "green" as const },
			{ text: "  0 to change, 0 to destroy" },
		],
		output: [
			{ text: "▸ Terraform apply...", color: "muted" as const },
			{ text: "" },
			{ text: "✓ aws_vpc.main", color: "green" as const },
			{ text: "✓ aws_eks_cluster.main", color: "green" as const },
			{ text: "✓ aws_rds_cluster.main", color: "green" as const },
			{ text: "✓ helm_release.argocd", color: "green" as const },
			{ text: "... +43 more" },
			{ text: "" },
			{ text: "✓ Apply complete!", color: "green" as const },
			{ text: "  47 added, 0 changed, 0 destroyed" },
			{ text: "  Duration: 12m 34s", color: "muted" as const },
		],
	},
	{
		id: "cost",
		label: "Cost Estimation",
		code: [
			{ text: "$ grape cost api-backend", color: "muted" as const },
			{ text: "" },
			{ text: "  ┌ Monthly Cost Breakdown ────────┐" },
			{ text: "  │                                 │" },
			{ text: "  │ EKS Cluster       $219.00      │" },
			{ text: "  │ Aurora DB          $412.00      │" },
			{ text: "  │ ElastiCache        $156.00      │" },
			{ text: "  │ NAT Gateway         $32.40      │" },
			{ text: "  │ Route 53             $1.00      │" },
			{ text: "  │ Other               $26.83      │" },
			{ text: "  │─────────────────────────────────│" },
			{ text: "  │ Total             $847.23/mo    │" },
			{ text: "  └─────────────────────────────────┘" },
		],
		output: [
			{ text: "  Powered by Infracost", color: "muted" as const },
			{ text: "" },
			{ text: "  Cost breakdown by category:" },
			{ text: "" },
			{ text: "  Compute       ██████████  48.7%", color: "blue" as const },
			{ text: "  Database      █████████   25.9%", color: "green" as const },
			{ text: "  Cache         ██████      18.4%", color: "yellow" as const },
			{ text: "  Network       ██           3.8%", color: "muted" as const },
			{ text: "  Other         █            3.2%", color: "muted" as const },
		],
	},
	{
		id: "destroy",
		label: "Teardown",
		code: [
			{ text: "$ grape destroy", color: "muted" as const },
			{ text: "" },
			{ text: "  ? Select vineyard: production" },
			{ text: "  ? Confirm destroy? (y/N): y" },
			{ text: "" },
			{ text: "  ▸ Disabling ArgoCD self-healing..." },
			{ text: "  ▸ Draining load balancers..." },
			{ text: "  ▸ Terraform destroy..." },
		],
		output: [
			{ text: "✓ ArgoCD disabled", color: "green" as const },
			{ text: "✓ Load balancers drained", color: "green" as const },
			{ text: "" },
			{ text: "✓ aws_rds_cluster destroyed", color: "green" as const },
			{ text: "✓ aws_eks_cluster destroyed", color: "green" as const },
			{ text: "✓ aws_vpc destroyed", color: "green" as const },
			{ text: "... +44 more" },
			{ text: "" },
			{ text: "✓ Destroy complete!", color: "green" as const },
			{ text: "  47 destroyed, 0 orphaned", color: "muted" as const },
		],
	},
];

const MODULES = [
	{
		icon: Globe,
		title: "Vertex",
		subtitle: "Web Control Plane",
		description:
			"Visual infrastructure configuration, job dashboard, real-time logs, cost estimation.",
		href: "/dashboard",
	},
	{
		icon: Terminal,
		title: "Grape",
		subtitle: "CLI + Worker",
		description:
			"Interactive terminal wizard for provisioning, deployment, and teardown.",
		href: "/docs",
	},
];

export function FeatureOverview() {
	return (
		<section id="features" className="py-24 md:py-32">
			<div className="container mx-auto px-4">
				<div className="max-w-[72rem] mx-auto">
					{/* Two-column layout */}
					<div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 lg:gap-16 items-start">
						{/* Left: text */}
						<div>
							<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
								Everything you need to ship infrastructure
							</h2>
							<p className="text-muted-foreground text-base leading-relaxed mb-8">
								Vertex gives you a visual configuration form and a
								CLI that share the same state. Design in the browser,
								execute from the terminal, reconcile with GitOps.
							</p>

							<div className="space-y-6">
								{BULLETS.map((b) => (
									<div key={b.title} className="flex gap-3">
										<div className="shrink-0 mt-0.5">
											<b.icon className="h-5 w-5 text-muted-foreground" />
										</div>
										<div>
											<h3 className="text-sm font-semibold text-foreground mb-1">
												{b.title}
											</h3>
											<p className="text-sm text-muted-foreground leading-relaxed">
												{b.description}
											</p>
										</div>
									</div>
								))}
							</div>
						</div>

						{/* Right: code demo */}
						<div>
							<CodeDemo tabs={DEMO_TABS} />
						</div>
					</div>

					{/* Module cards */}
					<div className="grid sm:grid-cols-2 gap-4 mt-16 max-w-[48rem] mx-auto">
						{MODULES.map((m) => (
							<Link
								key={m.title}
								href={m.href}
								className="group flex items-start gap-4 rounded-xl border border-border/50 p-5 transition-colors hover:border-border hover:bg-muted/30"
							>
								<div className="shrink-0 rounded-lg bg-muted/50 p-2.5">
									<m.icon className="h-5 w-5 text-foreground" />
								</div>
								<div className="min-w-0">
									<div className="flex items-center gap-2 mb-0.5">
										<h3 className="text-sm font-semibold text-foreground">
											{m.title}
										</h3>
										<span className="text-xs text-muted-foreground">
											{m.subtitle}
										</span>
									</div>
									<p className="text-xs text-muted-foreground leading-relaxed">
										{m.description}
									</p>
								</div>
								<ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
							</Link>
						))}
					</div>

					{/* CTA */}
					<div className="flex justify-center mt-10">
						<Link href="/dashboard">
							<Button variant="outline" size="lg" className="gap-2">
								Explore the Dashboard
								<ArrowRight className="h-4 w-4" />
							</Button>
						</Link>
					</div>

					{/* Provider logos (static) */}
					<div className="flex items-center justify-center gap-8 mt-8">
						{(["aws", "gcp", "azure"] as const).map((p) => (
							<ProviderIcon
								key={p}
								provider={p}
								size={20}
								className="opacity-30 grayscale"
							/>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
