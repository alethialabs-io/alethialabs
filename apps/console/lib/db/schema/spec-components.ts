// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-Spec component tables. All reference specs(spec_id) ON DELETE CASCADE;
// singletons are UNIQUE on spec_id, multi-component tables UNIQUE on (spec_id, name)
// — the composite/unique index also serves spec_id lookups, so no extra FK index.

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
	ProviderOutputs,
	RegistryProviderConfig,
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
import { specs } from "./specs";

const specRef = () =>
	uuid()
		.notNull()
		.references(() => specs.id, { onDelete: "cascade" });
const cost = () => numeric({ precision: 12, scale: 2, mode: "number" });
const ts = () => timestamp({ withTimezone: true }).defaultNow().notNull();

// ── Singletons (1:1 per spec) ────────────────────────────────────────────────

export const specNetwork = pgTable("spec_network", {
	id: uuid().primaryKey().defaultRandom(),
	spec_id: specRef().unique(),
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

export const specCluster = pgTable("spec_cluster", {
	id: uuid().primaryKey().defaultRandom(),
	spec_id: specRef().unique(),
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

export const specDns = pgTable("spec_dns", {
	id: uuid().primaryKey().defaultRandom(),
	spec_id: specRef().unique(),
	enabled: boolean().default(false).notNull(),
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

export const specRepositories = pgTable("spec_repositories", {
	id: uuid().primaryKey().defaultRandom(),
	spec_id: specRef().unique(),
	apps_destination_repo: text(),
	created_at: ts(),
	updated_at: ts(),
});

// ── Multi (1:N per spec, UNIQUE on (spec_id, name)) ───────────────────────────

export const specDatabases = pgTable(
	"spec_databases",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
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
	(t) => [unique("spec_databases_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specCaches = pgTable(
	"spec_caches",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
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
	(t) => [unique("spec_caches_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specQueues = pgTable(
	"spec_queues",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
		fifo: boolean().default(false),
		visibility_timeout: integer().default(30),
		message_retention: integer().default(345600),
		delay_seconds: integer().default(0),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("spec_queues_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specTopics = pgTable(
	"spec_topics",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
		subscriptions: jsonb().$type<TopicSubscription[]>().default([]),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("spec_topics_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specNosqlTables = pgTable(
	"spec_nosql_tables",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
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
	(t) => [unique("spec_nosql_tables_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specContainerRegistries = pgTable(
	"spec_container_registries",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
		repository_url: text(),
		// Provider-specific knobs (immutable_tags, vulnerability_scanning) — neutral JSONB.
		provider_config: jsonb().$type<RegistryProviderConfig>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("spec_container_registries_spec_id_name_key").on(t.spec_id, t.name),
	],
);

export const specSecrets = pgTable(
	"spec_secrets",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
		generate: boolean().default(true),
		length: integer().default(32),
		special_chars: boolean().default(true),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [unique("spec_secrets_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specStorageBuckets = pgTable(
	"spec_storage_buckets",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		name: text().notNull(),
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
	(t) => [unique("spec_storage_buckets_spec_id_name_key").on(t.spec_id, t.name)],
);

export const specGitCredentials = pgTable(
	"spec_git_credentials",
	{
		id: uuid().primaryKey().defaultRandom(),
		spec_id: specRef(),
		purpose: gitCredentialPurpose().notNull(),
		method: gitCredentialMethod().notNull(),
		provider_identity_id: uuid(),
		secret_ref: text(),
		created_at: ts(),
	},
	(t) => [
		check(
			"spec_git_credentials_source_ck",
			sql`${t.provider_identity_id} IS NOT NULL OR ${t.secret_ref} IS NOT NULL`,
		),
	],
);

// Append-only audit trail (user-readable; runners write via the service role).
export const auditLog = pgTable(
	"audit_log",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		spec_id: specRef(),
		user_id: uuid().notNull(),
		action: auditAction().notNull(),
		component_type: text(),
		component_id: uuid(),
		changes: jsonb().$type<AuditChanges>(),
		created_at: ts(),
	},
	(t) => [index("idx_audit_log_spec").on(t.spec_id)],
);
