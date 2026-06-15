// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Supported cloud provider identifiers. */
export type CloudProviderSlug = "aws" | "gcp" | "azure";

/** High-level metadata and service name mappings for a cloud provider. */
export interface CloudProviderMeta {
	slug: CloudProviderSlug;
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
export const PROVIDERS: Record<CloudProviderSlug, CloudProviderMeta> = {
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
};

/** How long cached cloud resources are considered fresh (hours). */
export const CACHE_TTL_HOURS = 24;

/** Returns provider metadata, defaulting to AWS if slug is unrecognized. */
export function getProvider(slug: string): CloudProviderMeta {
	return PROVIDERS[slug as CloudProviderSlug] ?? PROVIDERS.aws;
}
