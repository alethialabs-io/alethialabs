// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Clouds with full provisioning templates today. The per-cloud provisioning-option
 * catalogs (instance types, regions, DB engines, …) are keyed by this set.
 */
export type CloudProviderSlug = "aws" | "gcp" | "azure" | "hetzner";

/**
 * Every cloud a user can CONNECT (identity layer), including those whose OpenTofu
 * provisioning templates are still "coming soon" (alibaba/digitalocean/hetzner/civo).
 * The capability map (`PROVIDERS`) advertises service names for all of these.
 */
export type ConnectableCloudSlug =
	| CloudProviderSlug
	| "alibaba"
	| "digitalocean"
	| "civo";

/** High-level metadata and service name mappings for a cloud provider. */
export interface CloudProviderMeta {
	slug: ConnectableCloudSlug;
	name: string;
	shortName: string;
	icon: string;
	clusterService: string;
	networkName: string;
	dnsService: string;
	certService: string;
	dbService: string;
	cacheService: string;
	nosqlService: string;
	queueService: string;
	topicService: string;
	registryService: string;
	secretsService: string;
}

/** Provider metadata keyed by slug. */
export const PROVIDERS: Record<ConnectableCloudSlug, CloudProviderMeta> = {
	aws: {
		slug: "aws",
		name: "Amazon Web Services",
		shortName: "AWS",
		icon: "/aws/favicon_64x64.png",
		clusterService: "EKS",
		networkName: "VPC",
		dnsService: "Route 53",
		certService: "ACM",
		dbService: "Aurora",
		cacheService: "ElastiCache",
		nosqlService: "DynamoDB",
		queueService: "SQS",
		topicService: "SNS",
		registryService: "ECR",
		secretsService: "Secrets Manager",
	},
	gcp: {
		slug: "gcp",
		name: "Google Cloud Platform",
		shortName: "GCP",
		icon: "/gcp/favicon_64x64.png",
		clusterService: "GKE",
		networkName: "VPC Network",
		dnsService: "Cloud DNS",
		certService: "Managed Certificate",
		dbService: "Cloud SQL",
		cacheService: "Memorystore",
		nosqlService: "Firestore",
		queueService: "Pub/Sub",
		topicService: "Pub/Sub",
		registryService: "Artifact Registry",
		secretsService: "Secret Manager",
	},
	azure: {
		slug: "azure",
		name: "Microsoft Azure",
		shortName: "Azure",
		icon: "/azure/favicon_64x64.png",
		clusterService: "AKS",
		networkName: "VNet",
		dnsService: "Azure DNS",
		certService: "App Service Certificate",
		dbService: "Azure Database",
		cacheService: "Azure Cache for Redis",
		nosqlService: "Cosmos DB",
		queueService: "Service Bus",
		topicService: "Service Bus",
		registryService: "ACR",
		secretsService: "Key Vault",
	},
	alibaba: {
		slug: "alibaba",
		name: "Alibaba Cloud",
		shortName: "Alibaba",
		icon: "/alibaba/favicon_64x64.png",
		clusterService: "ACK",
		networkName: "VPC",
		dnsService: "Alibaba DNS",
		certService: "SSL Certificates",
		dbService: "ApsaraDB RDS",
		cacheService: "ApsaraDB for Redis",
		nosqlService: "Tablestore",
		queueService: "MNS",
		topicService: "MNS",
		registryService: "Container Registry (ACR)",
		secretsService: "KMS",
	},
	digitalocean: {
		slug: "digitalocean",
		name: "DigitalOcean",
		shortName: "DO",
		icon: "/digitalocean/favicon_64x64.png",
		clusterService: "DOKS",
		networkName: "VPC",
		dnsService: "DigitalOcean DNS",
		certService: "Let's Encrypt",
		dbService: "Managed Databases",
		cacheService: "Managed Redis",
		nosqlService: "—",
		queueService: "—",
		topicService: "—",
		registryService: "Container Registry",
		secretsService: "—",
	},
	hetzner: {
		slug: "hetzner",
		name: "Hetzner Cloud",
		shortName: "Hetzner",
		icon: "/hetzner/favicon_64x64.png",
		clusterService: "Talos / k3s (self-managed)",
		networkName: "Network",
		dnsService: "Hetzner DNS",
		certService: "Let's Encrypt",
		dbService: "—",
		cacheService: "—",
		nosqlService: "—",
		queueService: "—",
		topicService: "—",
		registryService: "—",
		secretsService: "—",
	},
	civo: {
		slug: "civo",
		name: "Civo",
		shortName: "Civo",
		icon: "/civo/favicon_64x64.png",
		clusterService: "Civo K3s",
		networkName: "Network",
		dnsService: "Civo DNS",
		certService: "Let's Encrypt",
		dbService: "Managed Databases",
		cacheService: "—",
		nosqlService: "—",
		queueService: "—",
		topicService: "—",
		registryService: "—",
		secretsService: "—",
	},
};

/** How long cached cloud resources are considered fresh (hours). */
export const CACHE_TTL_HOURS = 24;

/** Returns provider metadata, defaulting to AWS if slug is unrecognized. */
export function getProvider(slug: string): CloudProviderMeta {
	return PROVIDERS[slug as CloudProviderSlug] ?? PROVIDERS.aws;
}
