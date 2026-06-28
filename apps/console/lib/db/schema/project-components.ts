// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-Project component tables. All reference projects(project_id) ON DELETE CASCADE;
// singletons are UNIQUE on project_id, multi-component tables UNIQUE on (project_id, name)
// — the composite/unique index also serves project_id lookups, so no extra FK index.

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AuditChanges,
	ClusterAdmin,
	ClusterProviderConfig,
	DnsProviderConfig,
	NosqlProviderConfig,
	ObservabilityProviderConfig,
	ProviderOutputs,
	QueueProviderConfig,
	RegistryProviderConfig,
	SecretsProviderConfig,
	StorageProviderConfig,
	TopicSubscription,
} from "@/types/database-custom.types";
import {
	auditAction,
	cacheEngine,
	componentStatus,
	gitCredentialMethod,
	gitCredentialPurpose,
	nosqlCapacityMode,
	nosqlKeyType,
	nosqlTableType,
} from "./enums";
import { cloudIdentities } from "./identities";
import { projects } from "./projects";

const projectRef = () =>
	uuid()
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" });
// Per-resource cloud placement (the "versatile model"): each component may name
// its own cloud identity instead of inheriting the project's primary one. NULL means
// "inherit projects.cloud_identity_id". on delete set null so removing an identity
// just re-inherits rather than cascading the component away.
const ownerRef = () =>
	uuid().references(() => cloudIdentities.id, { onDelete: "set null" });
const cost = () => numeric({ precision: 12, scale: 2, mode: "number" });
const ts = () => timestamp({ withTimezone: true }).defaultNow().notNull();

// ── Singletons (1:1 per project) ────────────────────────────────────────────────

export const projectNetwork = pgTable("project_network", {
	id: uuid().primaryKey().defaultRandom(),
	project_id: projectRef().unique(),
	// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
	cloud_identity_id: ownerRef(),
	region: text(),
	provision_network: boolean().default(true).notNull(),
	network_id: text(),
	cidr_block: text().default("10.0.0.0/16"),
	single_nat_gateway: boolean().default(true),
	allowed_cidr_blocks: text().array().default([]),
	status: componentStatus().default("PENDING").notNull(),
	status_message: text(),
	estimated_monthly_cost: cost(),
	created_at: ts(),
	updated_at: ts(),
});

export const projectCluster = pgTable("project_cluster", {
	id: uuid().primaryKey().defaultRandom(),
	project_id: projectRef().unique(),
	// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
	cloud_identity_id: ownerRef(),
	region: text(),
	// No cloud-specific defaults: the provider mapper resolves the K8s version /
	// node instance types per cloud at provision time (the form supplies explicit
	// values for a chosen provider).
	cluster_version: text(),
	cluster_admins: jsonb().$type<ClusterAdmin[]>().default([]),
	instance_types: text().array(),
	node_min_size: integer().default(2),
	node_max_size: integer().default(5),
	node_desired_size: integer().default(2),
	provider_config: jsonb().$type<ClusterProviderConfig>().default({}),
	cluster_name: text(),
	cluster_endpoint: text(),
	argocd_url: text(),
	argocd_admin_password: text(),
	// Provider-specific resource identifiers (ARN/KMS/… on AWS) — cloud-agnostic.
	provider_outputs: jsonb().$type<ProviderOutputs>().default({}),
	status: componentStatus().default("PENDING").notNull(),
	status_message: text(),
	estimated_monthly_cost: cost(),
	created_at: ts(),
	updated_at: ts(),
});

export const projectDns = pgTable("project_dns", {
	id: uuid().primaryKey().defaultRandom(),
	project_id: projectRef().unique(),
	// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
	cloud_identity_id: ownerRef(),
	region: text(),
	enabled: boolean().default(false).notNull(),
	// Pluggable provider selector (connectors.slug). NULL / "native" = the cluster
	// cloud's native DNS (Route 53 / Cloud DNS / Azure DNS).
	provider: text(),
	zone_id: text(),
	domain_name: text(),
	managed_certificate: boolean().default(false),
	waf_enabled: boolean().default(false),
	provider_config: jsonb().$type<DnsProviderConfig>().default({}),
	status: componentStatus().default("PENDING").notNull(),
	status_message: text(),
	estimated_monthly_cost: cost(),
	created_at: ts(),
	updated_at: ts(),
});

// Observability component — no cloud-native default today; provider chooses the
// backend (datadog / grafana / prometheus). Singleton per project like DNS.
export const projectObservability = pgTable("project_observability", {
	id: uuid().primaryKey().defaultRandom(),
	project_id: projectRef().unique(),
	// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
	cloud_identity_id: ownerRef(),
	region: text(),
	enabled: boolean().default(false).notNull(),
	provider: text(),
	provider_config: jsonb().$type<ObservabilityProviderConfig>().default({}),
	status: componentStatus().default("PENDING").notNull(),
	status_message: text(),
	estimated_monthly_cost: cost(),
	created_at: ts(),
	updated_at: ts(),
});

export const projectRepositories = pgTable("project_repositories", {
	id: uuid().primaryKey().defaultRandom(),
	project_id: projectRef().unique(),
	apps_destination_repo: text(),
	created_at: ts(),
	updated_at: ts(),
});

// ── Multi (1:N per project, UNIQUE on (project_id, name)) ───────────────────────────

export const projectDatabases = pgTable(
	"project_databases",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// Provider-neutral: the mapper translates a generic engine family to the
		// cloud's managed DB (Aurora / Cloud SQL / Azure DB) at provision time.
		engine: text(),
		engine_version: text(),
		min_capacity: numeric({ precision: 6, scale: 2, mode: "number" }).default(0.5),
		max_capacity: numeric({ precision: 6, scale: 2, mode: "number" }).default(4),
		port: integer().default(5432),
		backup_retention_days: integer().default(7),
		iam_auth: boolean().default(false),
		endpoint: text(),
		reader_endpoint: text(),
		// Provider-specific resource identifiers (cluster ARN/identifier, credential
		// secret refs, KMS key on AWS) — cloud-agnostic JSONB.
		provider_outputs: jsonb().$type<ProviderOutputs>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_databases_project_id_name_key").on(t.project_id, t.name)],
);

export const projectCaches = pgTable(
	"project_caches",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		engine: cacheEngine().default("redis"),
		// Provider-neutral: the mapper picks the cloud's cache node type/SKU.
		node_type: text(),
		num_cache_nodes: integer().default(1),
		multi_az: boolean().default(false),
		allowed_cidr_blocks: text().array().default([]),
		endpoint: text(),
		// Redis/ElastiCache exposes a separate reader endpoint; the deploy finalizer
		// persists it. Missing from the original vine_caches table (the write silently
		// failed) — added during the Drizzle migration per the fix-as-you-go rule.
		reader_endpoint: text(),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_caches_project_id_name_key").on(t.project_id, t.name)],
);

export const projectQueues = pgTable(
	"project_queues",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		ordered: boolean().default(false),
		// Cross-cloud: SQS visibility ≈ Azure lock_duration ≈ Pub/Sub ack deadline.
		visibility_timeout: integer().default(30),
		message_retention: integer().default(345600),
		// Provider-specific queue knobs (SQS delay_seconds — no Azure/GCP equivalent).
		provider_config: jsonb().$type<QueueProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_queues_project_id_name_key").on(t.project_id, t.name)],
);

export const projectTopics = pgTable(
	"project_topics",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		subscriptions: jsonb().$type<TopicSubscription[]>().default([]),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_topics_project_id_name_key").on(t.project_id, t.name)],
);

export const projectNosqlTables = pgTable(
	"project_nosql_tables",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		table_type: nosqlTableType().default("standard"),
		partition_key: text().notNull(),
		partition_key_type: nosqlKeyType().default("S"),
		sort_key: text(),
		sort_key_type: nosqlKeyType(),
		capacity_mode: nosqlCapacityMode().default("on_demand"),
		point_in_time_recovery: boolean().default(true),
		global_replicas: text().array().default([]),
		provider_config: jsonb().$type<NosqlProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_nosql_tables_project_id_name_key").on(t.project_id, t.name)],
);

export const projectContainerRegistries = pgTable(
	"project_container_registries",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// Pluggable provider selector (connectors.slug). NULL / "native" = the
		// cluster cloud's native registry (ECR / Artifact Registry / ACR).
		provider: text(),
		repository_url: text(),
		// Provider-specific knobs (immutable_tags, vulnerability_scanning) — neutral JSONB.
		provider_config: jsonb().$type<RegistryProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_container_registries_project_id_name_key").on(t.project_id, t.name),
	],
);

export const projectSecrets = pgTable(
	"project_secrets",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// Pluggable provider selector (connectors.slug). NULL / "native" = the
		// cluster cloud's native secrets store (Secrets Manager / Secret Manager / Key Vault).
		provider: text(),
		generate: boolean().default(true),
		length: integer().default(32),
		special_chars: boolean().default(true),
		// Pluggable-provider knobs (Vault mount_path / kv_version) — neutral JSONB.
		provider_config: jsonb().$type<SecretsProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_secrets_project_id_name_key").on(t.project_id, t.name)],
);

export const projectStorageBuckets = pgTable(
	"project_storage_buckets",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		versioning: boolean().default(false),
		// Cross-cloud: whether at-rest encryption is on. The specific algorithm
		// (AES256 / aws:kms / CMEK …) is a provider-specific knob in provider_config.
		encryption_enabled: boolean().default(true),
		public_access: boolean().default(false),
		cors_origins: text().array().default([]),
		provider_config: jsonb().$type<StorageProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("project_storage_buckets_project_id_name_key").on(t.project_id, t.name)],
);

export const projectGitCredentials = pgTable(
	"project_git_credentials",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		purpose: gitCredentialPurpose().notNull(),
		method: gitCredentialMethod().notNull(),
		provider_identity_id: uuid(),
		secret_ref: text(),
		created_at: ts(),
	},
	(t) => [
		check(
			"project_git_credentials_source_ck",
			sql`${t.provider_identity_id} IS NOT NULL OR ${t.secret_ref} IS NOT NULL`,
		),
	],
);

// Append-only audit trail (user-readable; runners write via the service role).
export const auditLog = pgTable(
	"audit_log",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		project_id: projectRef(),
		user_id: uuid().notNull(),
		action: auditAction().notNull(),
		component_type: text(),
		component_id: uuid(),
		changes: jsonb().$type<AuditChanges>(),
		created_at: ts(),
	},
	(t) => [index("idx_audit_log_project").on(t.project_id)],
);
