// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import type {
	CloudCredentials,
	CachedResources,
	GcpCachedResources,
	SignedReceipt,
	VerifyControlResult,
	VerifyReport,
	VerifyReceiptBody,
	VerifyStatus,
} from "@/types/jsonb.types";
import { signReceipt } from "./receipt-sign";

/**
 * The curated demo dataset — believable-but-fictional customer "Acme Cloud"
 * across three projects on AWS / GCP / Hetzner. Deterministic (fixed values,
 * no randomness) so every seed and every capture session look identical. This
 * is the single source the builders insert from; it stays honest (real product
 * shapes, clearly-demo data — no real accounts, no fabricated precision beyond
 * plausible estimates).
 */

export type CloudProvider = "aws" | "gcp" | "hetzner";

export const DEMO = {
	orgName: "Acme Cloud",
	ownerName: "Dana Okoye",
	ownerEmail: "dana@acme.example",
	members: [
		{ name: "Rafael Costa", email: "rafael@acme.example", role: "admin" },
		{ name: "Mei Lin", email: "mei@acme.example", role: "member" },
	],
	teams: ["Platform", "Payments"],
} as const;

export interface ConnectorSpec {
	provider: CloudProvider;
	name: string;
	credentials: CloudCredentials;
	cachedResources: CachedResources | GcpCachedResources | null;
	verifiedAccountId: string | null;
}

export const CONNECTORS: ConnectorSpec[] = [
	{
		provider: "aws",
		name: "Acme — AWS Production",
		credentials: {
			role_arn: "arn:aws:iam::482913005711:role/alethia-provisioner",
			external_id: "acme-482913005711",
			account_id: "482913005711",
		},
		verifiedAccountId: "482913005711",
		cachedResources: {
			regions: ["eu-west-1", "us-east-1"],
			vpcs: {
				"eu-west-1": [{ ID: "vpc-0a1b2c3d", CIDR: "10.0.0.0/16", Name: "acme-prod", IsDefault: false }],
			},
			subnets: {},
			hosted_zones: [{ ID: "Z0891234ACME", Name: "acme.example.", RecordCount: 14, IsPrivate: false }],
		},
	},
	{
		provider: "gcp",
		name: "Acme — GCP",
		credentials: {
			project_id: "acme-storefront",
			project_number: "774105220913",
			service_account_email: "alethia@acme-storefront.iam.gserviceaccount.com",
		},
		verifiedAccountId: "acme-storefront",
		cachedResources: {
			regions: ["europe-west1", "us-central1"],
			networks: [{ name: "acme-vpc", selfLink: "projects/acme-storefront/global/networks/acme-vpc", autoCreateSubnetworks: false }],
			subnets: {},
			managed_zones: [{ name: "acme-zone", dnsName: "shop.acme.example.", visibility: "public" }],
		},
	},
	{
		provider: "hetzner",
		name: "Acme — Hetzner (self-managed)",
		credentials: { self_managed: true },
		verifiedAccountId: null,
		cachedResources: null,
	},
];

export interface ComponentSpec {
	network: { cidr_block: string; single_nat_gateway: boolean };
	cluster: {
		version: string;
		instance_types: string[];
		node_min: number;
		node_desired: number;
		node_max: number;
		name: string;
		endpoint: string;
		argocd_url: string;
	};
	databases: { name: string; engine_family: string; engine: string; endpoint: string; cost: number }[];
	caches: { name: string; engine: "redis" | "valkey"; endpoint: string; cost: number }[];
	buckets: { name: string; cost: number }[];
	registries: { name: string; repository_url: string }[];
	dns: { enabled: boolean; provider: string; domain_name: string } | null;
	addons: { addon_id: string; version: string; namespace: string }[];
	iac: { name: string; repo_url: string; path: string; commit_sha: string } | null;
}

export interface EnvSpec {
	stage: "development" | "staging" | "production";
	isDefault: boolean;
	monthlyCost: number;
	drifted: number;
	verdict: VerifyStatus;
	waiver?: { controls: string[]; reason: string };
}

export interface ProjectSpec {
	key: string;
	name: string;
	provider: CloudProvider;
	region: string;
	components: ComponentSpec;
	environments: EnvSpec[];
}

export const PROJECTS: ProjectSpec[] = [
	{
		key: "payments-api",
		name: "payments-api",
		provider: "aws",
		region: "eu-west-1",
		components: {
			network: { cidr_block: "10.0.0.0/16", single_nat_gateway: true },
			cluster: {
				version: "1.31",
				instance_types: ["m6i.large", "m6i.xlarge"],
				node_min: 2,
				node_desired: 3,
				node_max: 6,
				name: "payments-api-prod",
				endpoint: "https://a1b2c3.gr7.eu-west-1.eks.amazonaws.com",
				argocd_url: "https://argocd.payments.acme.example",
			},
			databases: [{ name: "orders", engine_family: "postgres", engine: "aurora-postgresql", endpoint: "orders.cluster-xyz.eu-west-1.rds.amazonaws.com", cost: 184 }],
			caches: [{ name: "sessions", engine: "redis", endpoint: "sessions.abc.ng.0001.euw1.cache.amazonaws.com", cost: 46 }],
			buckets: [{ name: "receipts", cost: 12 }],
			registries: [{ name: "payments", repository_url: "482913005711.dkr.ecr.eu-west-1.amazonaws.com/payments" }],
			dns: { enabled: true, provider: "route53", domain_name: "payments.acme.example" },
			addons: [{ addon_id: "kube-prometheus-stack", version: "62.3.1", namespace: "monitoring" }],
			iac: null,
		},
		environments: [
			{ stage: "production", isDefault: true, monthlyCost: 612, drifted: 0, verdict: "pass", waiver: { controls: ["net-002"], reason: "Public ALB required for partner webhook ingress; compensating WAF in place." } },
			{ stage: "staging", isDefault: false, monthlyCost: 291, drifted: 1, verdict: "warn" },
			{ stage: "development", isDefault: false, monthlyCost: 118, drifted: 0, verdict: "pass" },
		],
	},
	{
		key: "web-storefront",
		name: "web-storefront",
		provider: "gcp",
		region: "europe-west1",
		components: {
			network: { cidr_block: "10.8.0.0/16", single_nat_gateway: true },
			cluster: {
				version: "1.31",
				instance_types: ["e2-standard-4"],
				node_min: 2,
				node_desired: 2,
				node_max: 5,
				name: "web-storefront-prod",
				endpoint: "https://34.140.22.11",
				argocd_url: "https://argocd.shop.acme.example",
			},
			databases: [{ name: "catalog", engine_family: "postgres", engine: "cloudsql-postgres", endpoint: "10.8.4.3", cost: 142 }],
			caches: [{ name: "cart", engine: "redis", endpoint: "10.8.5.7", cost: 38 }],
			buckets: [{ name: "assets", cost: 9 }],
			registries: [{ name: "storefront", repository_url: "europe-west1-docker.pkg.dev/acme-storefront/storefront" }],
			dns: { enabled: true, provider: "clouddns", domain_name: "shop.acme.example" },
			addons: [{ addon_id: "kube-prometheus-stack", version: "62.3.1", namespace: "monitoring" }],
			iac: null,
		},
		environments: [
			{ stage: "production", isDefault: true, monthlyCost: 408, drifted: 0, verdict: "pass" },
			{ stage: "staging", isDefault: false, monthlyCost: 176, drifted: 0, verdict: "pass" },
		],
	},
	{
		key: "data-platform",
		name: "data-platform",
		provider: "hetzner",
		region: "nbg1",
		components: {
			network: { cidr_block: "10.16.0.0/16", single_nat_gateway: false },
			cluster: {
				version: "1.31",
				instance_types: ["cpx31"],
				node_min: 3,
				node_desired: 3,
				node_max: 6,
				name: "data-platform-prod",
				endpoint: "https://data.acme.example:6443",
				argocd_url: "https://argocd.data.acme.example",
			},
			// Hetzner: an in-cluster CloudNativePG database, cloud-honest (not a managed service).
			databases: [{ name: "warehouse", engine_family: "postgres", engine: "cloudnative-pg", endpoint: "warehouse-rw.data.svc.cluster.local", cost: 0 }],
			caches: [],
			buckets: [{ name: "lakehouse", cost: 21 }],
			registries: [],
			dns: null,
			addons: [{ addon_id: "kube-prometheus-stack", version: "62.3.1", namespace: "monitoring" }],
			iac: { name: "networking", repo_url: "github.com/acme/infra", path: "stacks/hetzner-network", commit_sha: "9f3c2e14a71b0d55e2c8f4a190bb7e3d6c012a4f" },
		},
		environments: [{ stage: "production", isDefault: true, monthlyCost: 214, drifted: 2, verdict: "pass" }],
	},
];

/** Fixed catalog version stamped on verify reports/receipts. */
export const CATALOG_VERSION = "2026.07.1";

const CONTROLS_BY_PROVIDER: Record<CloudProvider, Omit<VerifyControlResult, "provider">[]> = {
	aws: [
		{ id: "iam-001", title: "No static IAM access keys", severity: "high", status: "pass", frameworks: ["SOC2 CC6.1"] },
		{ id: "iam-002", title: "OIDC subject bound to repo", severity: "high", status: "pass", frameworks: ["SOC2 CC6.1"] },
		{ id: "iam-003", title: "Provisioner role least-privilege", severity: "medium", status: "pass" },
		{ id: "net-001", title: "Data stores in private subnets", severity: "high", status: "pass" },
		{ id: "net-002", title: "No public ingress on data stores", severity: "high", status: "pass" },
		{ id: "enc-001", title: "Encryption at rest enabled", severity: "medium", status: "pass" },
	],
	gcp: [
		{ id: "wif-001", title: "Workload Identity Federation (keyless)", severity: "high", status: "pass", frameworks: ["SOC2 CC6.1"] },
		{ id: "wif-002", title: "OIDC subject bound to repo", severity: "high", status: "pass" },
		{ id: "iam-003", title: "Service account least-privilege", severity: "medium", status: "pass" },
		{ id: "net-001", title: "Private GKE control plane", severity: "high", status: "pass" },
		{ id: "enc-001", title: "CMEK encryption at rest", severity: "medium", status: "not_evaluable", coverage: "Plan does not surface key binding for this resource." },
		{ id: "net-002", title: "No public ingress on data stores", severity: "high", status: "pass" },
	],
	hetzner: [
		{ id: "net-001", title: "Cluster API not publicly exposed", severity: "high", status: "pass" },
		{ id: "net-003", title: "Default-deny network policy", severity: "medium", status: "pass" },
		{ id: "enc-001", title: "Volume encryption enabled", severity: "medium", status: "pass" },
		{ id: "sec-001", title: "No plaintext secrets in manifests", severity: "high", status: "pass" },
	],
};

/** Builds a realistic VerifyReport for a provider, tuned to a target verdict. */
export function verifyReport(provider: CloudProvider, verdict: VerifyStatus): VerifyReport {
	const controls: VerifyControlResult[] = CONTROLS_BY_PROVIDER[provider].map((c) => ({ ...c, provider }));
	// For a "warn" verdict, downgrade one medium control to warn with a finding.
	if (verdict === "warn") {
		const target = controls.find((c) => c.severity === "medium" && c.status === "pass");
		if (target) {
			target.status = "warn";
			target.findings = [{ address: "module.cluster.node_group", message: "Broader than recommended egress; review before production." }];
		}
	}
	const summary = { pass: 0, fail: 0, warn: 0, not_evaluable: 0 };
	for (const c of controls) summary[c.status] += 1;
	return { verdict, catalog_version: CATALOG_VERSION, provider, controls, summary };
}

/** Deterministic hex sha256 (stands in for the plan-bytes hash). */
export function planSha(key: string): string {
	return createHash("sha256").update(`demo-plan::${key}`).digest("hex");
}

/** Wraps a report in a signed (or honestly-unsigned) receipt. */
export function receipt(report: VerifyReport, provider: CloudProvider, key: string, evaluatedAt: string): SignedReceipt {
	const body: VerifyReceiptBody = {
		version: "1",
		plan_sha256: planSha(key),
		tofu_version: "1.8.3",
		provider_versions: providerVersions(provider),
		catalog_version: CATALOG_VERSION,
		provider,
		verdict: report.verdict,
		report,
		runner: "demo-runner-eu-1",
		evaluated_at: evaluatedAt,
	};
	return signReceipt(body);
}

function providerVersions(provider: CloudProvider): Record<string, string> {
	if (provider === "aws") return { aws: "5.62.0", helm: "2.14.0" };
	if (provider === "gcp") return { google: "5.39.0", helm: "2.14.0" };
	return { hcloud: "1.48.0", helm: "2.14.0" };
}

/** The streamed log lines for a successful PLAN job. */
export function planLog(project: ProjectSpec, addCount: number): string[] {
	return [
		"$ alethia project plan",
		"▸ Compiling sections → OpenTofu",
		`▸ ${project.provider.toUpperCase()} · ${project.region}`,
		`${addCount} to add · 0 to change · 0 to destroy`,
		"▸ Estimating cost · Infracost",
		"▸ Verifying plan · elench",
		"✓ verify: all controls passed",
		"✓ Plan complete",
	];
}

/** The streamed log lines for a successful DEPLOY job. */
export function deployLog(project: ProjectSpec): string[] {
	const c = project.components;
	return [
		"$ alethia project apply",
		"✓ queued job · runner demo-runner-eu-1",
		`✓ ${c.cluster.name} · ${c.cluster.version}`,
		"✓ cni ready · nodes Ready",
		"✓ helm_release.argocd",
		"✓ argocd: Applications Healthy + Synced",
		"✓ evidence receipt sealed · ed25519",
		"✓ Apply complete",
	];
}
