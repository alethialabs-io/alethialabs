// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema/enums";

/**
 * Clouds with full provisioning templates today. The per-cloud provisioning-option
 * catalogs (instance types, regions, DB engines, …) are keyed by this set — a curated
 * SUBSET of the generated `cloud_provider` enum (derived, so it can't silently drift).
 */
export type CloudProviderSlug = Extract<
	CloudProvider,
	"aws" | "gcp" | "azure" | "hetzner" | "alibaba"
>;

/**
 * Every cloud a user can CONNECT (identity layer), including those whose OpenTofu
 * provisioning templates are still "coming soon" (digitalocean/civo). Every DB-representable
 * cloud is connectable, so this is exactly the generated `cloud_provider` enum.
 */
export type ConnectableCloudSlug = CloudProvider;

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
	storageService: string;
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
		storageService: "S3",
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
		storageService: "Cloud Storage",
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
		storageService: "Blob Storage",
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
		storageService: "OSS",
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
		storageService: "Spaces",
	},
	hetzner: {
		slug: "hetzner",
		name: "Hetzner Cloud",
		shortName: "Hetzner",
		icon: "/hetzner/favicon_64x64.png",
		clusterService: "Talos Kubernetes",
		networkName: "Hetzner Network",
		// Compute-only cloud: data services run as in-cluster OSS Helm charts, not managed services.
		dnsService: "ExternalDNS",
		certService: "Let's Encrypt",
		dbService: "CloudNativePG (in-cluster)",
		cacheService: "Valkey (in-cluster)",
		nosqlService: "—",
		queueService: "RabbitMQ (in-cluster)",
		topicService: "—",
		registryService: "Harbor (in-cluster)",
		secretsService: "Vault (in-cluster)",
		// Native S3-compatible Object Storage (aminueza/minio provider against the Hetzner
		// S3 endpoint) — see infra/templates/project/hetzner/buckets.tf.
		storageService: "Object Storage",
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
		storageService: "Object Store",
	},
};

/** How long cached cloud resources are considered fresh (hours). */
export const CACHE_TTL_HOURS = 24;

/** Returns provider metadata, defaulting to AWS if slug is unrecognized. */
export function getProvider(slug: string): CloudProviderMeta {
	return PROVIDERS[slug as CloudProviderSlug] ?? PROVIDERS.aws;
}
