// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-Project component tables. All reference projects(project_id) ON DELETE CASCADE and carry an
// environment_id (the environment of the project they configure) — singletons are UNIQUE on
// (project_id, environment_id), multi-component tables UNIQUE on (project_id, environment_id, name).
// So each environment owns an independent set of components; the composite/unique index also serves
// project_id lookups, so no extra FK index.

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
	AddOnValues,
	ArgocdSyncStatus,
	AuditChanges,
	ChartValuePathMap,
	ChartWorkloadConfig,
	ChartWorkloadRendered,
	ClusterAdmin,
	ClusterProviderConfig,
	DetectedService,
	DnsProviderConfig,
	IacScanReport,
	IacVarValues,
	NodeSize,
	NosqlProviderConfig,
	ObservabilityProviderConfig,
	ProviderOutputs,
	QueueProviderConfig,
	RegistryProviderConfig,
	ScanStatus,
	SecretsProviderConfig,
	ServiceBinding,
	ServiceBuild,
	ServiceEnvVar,
	ServicePort,
	ServiceProbe,
	ServiceResources,
	ServiceSource,
	StagedChangePayload,
	StorageProviderConfig,
	TopicSubscription,
	VerifyReport,
} from "@/types/jsonb.types";
import {
	addonMode,
	auditAction,
	cacheEngine,
	changeOp,
	chartWorkloadKind,
	componentStatus,
	gitCredentialMethod,
	gitCredentialPurpose,
	nosqlCapacityMode,
	nosqlKeyType,
	nosqlTableType,
	serviceWorkloadType,
	topicSubscriptionProtocol,
} from "./enums";
import { cloudIdentities } from "./identities";
import { projectEnvironments } from "./project-environments";
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
// Environment scope — each component row belongs to ONE environment of the project, so a
// project's environments hold independent config. Nullable during the transition (the
// programmables.sql backfill attaches existing rows to the project's default env); the app
// always sets it. ON DELETE CASCADE so deleting an environment removes its component rows.
const envRef = () =>
	uuid().references(() => projectEnvironments.id, { onDelete: "cascade" });
const cost = () => numeric({ precision: 12, scale: 2, mode: "number" });
const ts = () => timestamp({ withTimezone: true }).defaultNow().notNull();

// ── Singletons (1:1 per project environment) ────────────────────────────────────

export const projectNetwork = pgTable(
	"project_network",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	},
	(t) => [
		unique("project_network_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

export const projectCluster = pgTable(
	"project_cluster",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// No cloud-specific defaults: the provider mapper resolves the K8s version /
		// node instance types per cloud at provision time (the form supplies explicit
		// values for a chosen provider).
		cluster_version: text(),
		cluster_admins: jsonb().$type<ClusterAdmin[]>().default([]),
		// Cloud-indifferent node capability ({vcpu, memory_gb}); the Go resolver maps it to
		// the nearest per-provider instance type at provision time.
		node_size: jsonb().$type<NodeSize>(),
		// Legacy concrete provider SKUs; the resolver falls back to these when node_size is unset.
		instance_types: text().array(),
		node_min_size: integer().default(2),
		node_max_size: integer().default(5),
		node_desired_size: integer().default(2),
		// Worker-node root disk size (GB). NULL → the per-cloud template default applies
		// (EKS 50 / GKE 50 / AKS 100). Maps to eks_disk_size / gke_disk_size_gb / aks_disk_size_gb.
		node_disk_size_gb: integer(),
		provider_config: jsonb().$type<ClusterProviderConfig>().default({}),
		cluster_name: text(),
		cluster_endpoint: text(),
		argocd_url: text(),
		// Provider-specific resource identifiers (ARN/KMS/… on AWS) — cloud-agnostic.
		provider_outputs: jsonb().$type<ProviderOutputs>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_cluster_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

// A cluster's day-2 admins, normalized out of project_cluster.cluster_admins JSONB. `groups` is a
// real text[] column; `ordinal` preserves author order so buildConfigSnapshot re-embeds a
// byte-identical array. Tenancy flows through the parent cluster → project (join-through RLS in
// programmables.sql). ON DELETE CASCADE: clearing the cluster drops its admins.
export const clusterAdmins = pgTable(
	"cluster_admins",
	{
		id: uuid().primaryKey().defaultRandom(),
		cluster_id: uuid()
			.notNull()
			.references(() => projectCluster.id, { onDelete: "cascade" }),
		username: text().notNull(),
		groups: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		ordinal: integer().notNull(),
		created_at: ts(),
	},
	(t) => [index("cluster_admins_cluster_id_idx").on(t.cluster_id)],
);

export const projectDns = pgTable(
	"project_dns",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	},
	(t) => [
		unique("project_dns_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

// Observability component — no cloud-native default today; provider chooses the
// backend (datadog / grafana / prometheus). Singleton per project environment like DNS.
export const projectObservability = pgTable(
	"project_observability",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	},
	(t) => [
		unique("project_observability_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

// Marketplace add-ons — free OSS apps (Grafana, Loki, Vault, …) the cluster comes up with,
// deployed as ArgoCD Helm Applications. One row per enabled catalog add-on per environment
// (UNIQUE on (project_id, environment_id, addon_id)). `addon_id` references the code catalog
// (lib/addons/catalog.ts), NOT a DB enum, so the catalog grows without a migration. Health +
// sync_status are read back from ArgoCD after deploy. Multi-component (1:N per env) like the
// databases/caches tables.
export const projectAddons = pgTable(
	"project_addons",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		// Catalog id (lib/addons/catalog.ts) — e.g. "kube-prometheus-stack" — for source='catalog'.
		// For source='byo' it's a per-env slug for the user's chart (e.g. its release name). Not a
		// DB enum. UNIQUE per env either way.
		addon_id: text().notNull(),
		// 'catalog' = a marketplace OSS chart (chart coords come from the code catalog); 'byo' = the
		// customer's OWN Helm chart pulled from a connected git repo (chart_repo=git URL, chart_path
		// = the chart dir within it, version = git ref). Governs which resolver builds the install spec.
		source: text().default("catalog").notNull(),
		// The chart directory within the git repo for source='byo' (e.g. "charts/payments"). NULL for
		// catalog add-ons (their chart lives in a Helm registry).
		chart_path: text(),
		// For source='byo': the git repo URL that holds the chart (ArgoCD clones it). NULL for catalog.
		chart_repo: text(),
		// For source='byo': the projectGitCredentials row (purpose='applications') used to clone the
		// chart repo. NULL = public repo / owner-OAuth fallback.
		git_credential_id: uuid().references(() => projectGitCredentials.id, {
			onDelete: "set null",
		}),
		enabled: boolean().default(true).notNull(),
		mode: addonMode().default("managed").notNull(),
		// Chart version override; NULL = the catalog's pinned default.
		version: text(),
		// The user's tuned knobs (validated per add-on by its Zod configSchema), or a raw
		// Helm-values override in gitops mode.
		values: jsonb().$type<AddOnValues>().default({}),
		// Raw Helm-values YAML the user typed (Advanced) — deep-merged on top of the schema
		// knobs at resolve time (highest precedence). NULL = none.
		values_yaml: text(),
		namespace: text(),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		// ArgoCD Application health read back after deploy: Healthy | Progressing | Degraded |
		// Missing | Unknown. NULL until the first post-deploy read.
		health: text(),
		// ArgoCD sync state: Synced | OutOfSync | Unknown.
		sync_status: text().$type<ArgocdSyncStatus>(),
		last_synced_at: timestamp({ withTimezone: true }),
		// BYO chart-safety scan (source='byo'): the elench verify.Report over the chart's rendered
		// manifests (helm template → EvaluateManifests), its lifecycle, and when it last ran.
		scan_status: text().$type<ScanStatus>().default("unscanned").notNull(), // unscanned | scanning | done | failed
		scan_report: jsonb().$type<VerifyReport>(),
		scanned_at: timestamp({ withTimezone: true }),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_addons_project_id_environment_id_addon_id_key").on(
			t.project_id,
			t.environment_id,
			t.addon_id,
		),
	],
);

export const projectRepositories = pgTable(
	"project_repositories",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		apps_destination_repo: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_repositories_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

// Source repos scanned to infer the project (1:N — a project may aggregate several
// repos, and a monorepo yields per-service entries). Distinct from projectRepositories,
// which is the single GitOps *destination* (apps_destination_repo) ArgoCD deploys from.
export const projectSourceRepos = pgTable(
	"project_source_repos",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		repo_url: text().notNull(),
		// Branch/tag/sha; NULL = the repo's default branch.
		ref: text(),
		// Subpath scanned within the repo; "" = root. Lets one monorepo attach multiple
		// times (once per service subtree) under distinct scan paths.
		scan_path: text().default("").notNull(),
		// Monorepo-aware services detected at scan time (path + name + runtime/port).
		services: jsonb().$type<DetectedService[]>().default([]),
		// Optional per-repo git credential (project_git_credentials.id) for a private repo;
		// NULL = public / inherit. Soft reference (matches provider_identity_id's pattern).
		git_credential_id: uuid(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique(
			"project_source_repos_project_env_repo_path_key",
		).on(t.project_id, t.environment_id, t.repo_url, t.scan_path),
	],
);

// Bring-your-own IaC (E3): a git repo holding an OpenTofu ROOT MODULE attached to a project
// environment. When an enabled row exists (and the flag is on), that environment's
// PLAN/DEPLOY/DESTROY/DETECT_DRIFT jobs run the customer's module instead of the built-in
// per-cloud template (v1 = REPLACE mode). Patterned on projectSourceRepos (repo coords) +
// the BYO columns of projectAddons (git credential + scan lifecycle). Singleton per env for
// v1 (UNIQUE(project_id, environment_id)); `name` exists so multi-stack can relax that later.
export const projectIacSources = pgTable(
	"project_iac_sources",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		// Stack name — reserved for future multi-stack support; v1 always 'default'.
		name: text().default("default").notNull(),
		repo_url: text().notNull(),
		// Branch/tag to scan; NULL = the repo's default branch.
		ref: text(),
		// Root-module directory within the repo; "" = repo root.
		path: text().default("").notNull(),
		// The commit pinned by the last successful IAC_SCAN — provisioning checks out THIS
		// sha (never the moving ref), so what was scanned is exactly what applies (TOCTOU
		// protection). NULL until the first successful scan; provisioning is gated on it.
		commit_sha: text(),
		// The commit a successful DEPLOY actually applied (the module that created live
		// state). Set by finalizeDeployment on DEPLOY success, cleared on DESTROY success.
		// DESTROY tears down THIS commit's module (not a newer unpinned re-scan), and detach
		// is blocked while it is set (the env holds live BYO infra).
		deployed_commit_sha: text(),
		// The projectGitCredentials row (purpose='infrastructure') used to clone the repo.
		// NULL = public repo / owner-OAuth fallback (the runner's git-token route).
		git_credential_id: uuid().references(() => projectGitCredentials.id, {
			onDelete: "set null",
		}),
		// Customer-supplied NON-SECRET tfvars for the root module (scalars only).
		var_values: jsonb().$type<IacVarValues>().default({}),
		enabled: boolean().default(true).notNull(),
		// IaC-safety scan lifecycle: unscanned | scanning | done | failed (projectAddons pattern).
		scan_status: text().$type<ScanStatus>().default("unscanned").notNull(),
		scan_report: jsonb().$type<IacScanReport>(),
		scanned_at: timestamp({ withTimezone: true }),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_iac_sources_project_id_environment_id_key").on(
			t.project_id,
			t.environment_id,
		),
	],
);

// ── Multi (1:N per project environment, UNIQUE on (project_id, environment_id, name)) ──

export const projectDatabases = pgTable(
	"project_databases",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// Cloud-indifferent engine family ("postgres" | "mysql") — the Go resolver maps it
		// to the cloud's managed DB (Aurora / Cloud SQL / Azure DB) at provision time.
		engine_family: text(),
		// Legacy concrete provider engine (e.g. "aurora-postgresql"); kept for back-compat
		// — the resolver falls back to it when engine_family is unset.
		engine: text(),
		engine_version: text(),
		// Provider-neutral instance sizing. NULL → template default. Maps to
		// rds_instance_type (AWS) / cloud_sql_tier (GCP) / azure_db_sku_name (Azure).
		instance_class: text(),
		min_capacity: numeric({ precision: 6, scale: 2, mode: "number" }).default(0.5),
		max_capacity: numeric({ precision: 6, scale: 2, mode: "number" }).default(4),
		// Cloud-indifferent in-cluster sizing; used by compute-only clouds (e.g. Hetzner,
		// where a database node deploys as a CloudNativePG cluster instead of a managed
		// service): persistent-volume size in GiB and instance count. NULL → the in-cluster
		// mapper's defaults stay authoritative (10Gi / 1 instance).
		storage_gb: integer(),
		replicas: integer(),
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
	(t) => [
		unique("project_databases_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectCaches = pgTable(
	"project_caches",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		engine: cacheEngine().default("redis"),
		// Engine version. NULL → template default (Redis 7.1 / Memorystore REDIS_7_0 /
		// Azure 6). Maps to redis_engine_version / memorystore_redis_version / azure_cache_redis_version.
		engine_version: text(),
		// Provider-neutral: the mapper picks the cloud's cache node type/SKU.
		// Cloud-indifferent size in GB; the Go resolver maps it to the nearest provider cache
		// SKU. Legacy concrete node_type below is the resolver's fallback.
		memory_gb: numeric({ precision: 8, scale: 2, mode: "number" }),
		// Cloud-indifferent in-cluster sizing; used by compute-only clouds (e.g. Hetzner,
		// where a cache node deploys as a Valkey chart): persistent-volume size in GiB.
		// NULL → the in-cluster mapper falls back to memory_gb, then its default (8Gi).
		storage_gb: integer(),
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
	(t) => [
		unique("project_caches_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectQueues = pgTable(
	"project_queues",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		ordered: boolean().default(false),
		// Cloud-indifferent in-cluster sizing; used by compute-only clouds (e.g. Hetzner,
		// where a queue node deploys as a RabbitMQ chart): persistent-volume size in GiB.
		// NULL → the in-cluster mapper's default stays authoritative (8Gi).
		storage_gb: integer(),
		// Cross-cloud: SQS visibility ≈ Azure lock_duration ≈ Pub/Sub ack deadline.
		visibility_timeout: integer().default(30),
		message_retention: integer().default(345600),
		// Provider-specific queue knobs (SQS delay_seconds — no Azure/GCP equivalent).
		provider_config: jsonb().$type<QueueProviderConfig>().default({}),
		// Connection endpoint written back by the deploy finalizer. Databases + caches have had
		// these since day one; queues never did, so an in-cluster RabbitMQ (Hetzner, where a queue
		// deploys as an ArgoCD Application rather than a managed cloud resource) had nowhere to
		// record its Service DNS name. `provider_outputs.secret_ref` carries a REFERENCE to the
		// credential Secret ("<namespace>/<name>") — never the credential itself (#427).
		endpoint: text(),
		provider_outputs: jsonb().$type<ProviderOutputs>().default({}),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_queues_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectTopics = pgTable(
	"project_topics",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	(t) => [
		unique("project_topics_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

// A topic's delivery subscriptions, normalized out of project_topics.subscriptions JSONB (the
// finite `protocol` is a real enum column + `topic_id` gives FK integrity). `ordinal` preserves the
// author-order the JSONB array had, so buildConfigSnapshot re-embeds a byte-identical array.
// Tenancy flows through the parent topic → project (join-through RLS in programmables.sql, like the
// support-case child tables). ON DELETE CASCADE: clearing a topic drops its subscriptions.
export const topicSubscriptions = pgTable(
	"topic_subscriptions",
	{
		id: uuid().primaryKey().defaultRandom(),
		topic_id: uuid()
			.notNull()
			.references(() => projectTopics.id, { onDelete: "cascade" }),
		protocol: topicSubscriptionProtocol().notNull(),
		endpoint: text().notNull(),
		ordinal: integer().notNull(),
		created_at: ts(),
	},
	(t) => [index("topic_subscriptions_topic_id_idx").on(t.topic_id)],
);

export const projectNosqlTables = pgTable(
	"project_nosql_tables",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	(t) => [
		unique("project_nosql_tables_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectContainerRegistries = pgTable(
	"project_container_registries",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
		unique("project_container_registries_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectSecrets = pgTable(
	"project_secrets",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	(t) => [
		unique("project_secrets_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

export const projectStorageBuckets = pgTable(
	"project_storage_buckets",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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
	(t) => [
		unique("project_storage_buckets_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

// A first-class application workload on the cluster (W1 — the north-star service model). Unlike the
// infra kinds above, a service is the customer's own code: built from a repo (Dockerfile → image in
// W2) or a prebuilt image, run as a Deployment/Job/CronJob/StatefulSet. Infra-binding edges
// (service→db/cache/secret) are W3; secret env-from is W4. The runner turns these into k8s manifests.
export const projectServices = pgTable(
	"project_services",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		name: text().notNull(),
		// Per-resource cloud placement — NULL inherits projects.cloud_identity_id / region.
		cloud_identity_id: ownerRef(),
		region: text(),
		// Workload type: deployment (default) | job | cronjob | statefulset. pgEnum-backed so the
		// column can't drift from the service form fragment's `type` union.
		type: serviceWorkloadType().default("deployment").notNull(),
		// Where the image comes from — {kind:"repo",repo_url,path} | {kind:"image",image}.
		source: jsonb().$type<ServiceSource>().notNull(),
		// Build config when source.kind === "repo" (Dockerfile/context); NULL for a prebuilt image.
		build: jsonb().$type<ServiceBuild>(),
		// Plain environment variables (secret env-from is W4).
		env: jsonb().$type<ServiceEnvVar[]>().default([]).notNull(),
		// W3 — declared edges to backing resources (service→database/cache/queue/secret) plus the
		// env each injects. The runner resolves each binding to the provisioned resource's endpoint
		// (tofu output) / credentials (ExternalSecret → k8s Secret) at deploy time.
		bindings: jsonb().$type<ServiceBinding[]>().default([]).notNull(),
		// Container ports the workload exposes.
		ports: jsonb().$type<ServicePort[]>().default([]).notNull(),
		replicas: integer().default(2).notNull(),
		// Compute requests/limits (k8s quantity strings, e.g. "100m"/"128Mi"); NULL → template defaults.
		resources: jsonb().$type<ServiceResources>(),
		// Readiness/liveness probe; NULL = none.
		probe: jsonb().$type<ServiceProbe>(),
		// W2 — the build's write-back slot (output column, like registries.repository_url):
		// the pushed image digest URI (e.g. "<acct>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:…")
		// persisted from a BUILD job's result. Distinct from `source` (the user's input);
		// never designed by the user, stripped from the form/design view.
		resolved_image: text(),
		status: componentStatus().default("PENDING").notNull(),
		status_message: text(),
		estimated_monthly_cost: cost(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_services_project_id_environment_id_name_key").on(
			t.project_id,
			t.environment_id,
			t.name,
		),
	],
);

// A workload DESCRIBED from a BYO Helm chart's rendered manifests (W5 Path A — Option B). The chart
// (a project_addons source='byo' row) stays the single DEPLOY UNIT — its ArgoCD Application deploys
// everything. These rows are read-mostly DESCRIPTIONS Alethia never renders or deploys itself: they
// are deliberately NOT project_services rows, so a described workload can never enter the deploy
// path (no double-deploy). One row per rendered workload (Deployment/StatefulSet/DaemonSet/CronJob/
// Job). `rendered` is refreshed verbatim on every CHART_SCAN; the user overlay (bindings/config/
// value_paths) is PRESERVED across re-scans. See management/spec/features/w5-path-a-byo-services.md.
export const projectChartWorkloads = pgTable(
	"project_chart_workloads",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
		// The owning BYO chart addon (project_addons.id, source='byo') — the deploy unit. ON DELETE
		// CASCADE so detaching the chart removes its described workloads.
		addon_id: uuid()
			.notNull()
			.references(() => projectAddons.id, { onDelete: "cascade" }),
		// The rendered workload's metadata.name (unique within a chart addon).
		name: text().notNull(),
		// Which workload kind the manifest declared (normalized lowercase).
		workload_kind: chartWorkloadKind().notNull(),
		// The pure description extracted from `helm template` output — OVERWRITTEN wholesale on every
		// re-scan (it mirrors the chart, not the user).
		rendered: jsonb().$type<ChartWorkloadRendered>().notNull(),
		// W3 — the user's declared bindings to backing resources. PRESERVED across re-scans. On deploy
		// (Lane 2) each binding writes into the chart's values at the declared value-path (a keyless
		// secret-ref for credential facets), never re-rendering the workload.
		bindings: jsonb().$type<ServiceBinding[]>().default([]).notNull(),
		// The user's editable overlay (v1: replicas + env), written back into the chart's values on
		// deploy. PRESERVED across re-scans.
		config: jsonb().$type<ChartWorkloadConfig>().default({}).notNull(),
		// Where each binding/config knob writes into the chart's values (logical knob → dot-path).
		// Auto-inferred at scan + user-overridable (Lane 2). PRESERVED across re-scans.
		value_paths: jsonb().$type<ChartValuePathMap>().default({}).notNull(),
		created_at: ts(),
		updated_at: ts(),
	},
	(t) => [
		unique("project_chart_workloads_project_env_addon_name_key").on(
			t.project_id,
			t.environment_id,
			t.addon_id,
			t.name,
		),
	],
);

export const projectGitCredentials = pgTable(
	"project_git_credentials",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		environment_id: envRef(),
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

// Durable staging for canvas edits before they go live — the diff (desired graph vs the
// saved config) the Pending Changes bar reads. applyStagedChanges() writes them into the
// component tables + clears these rows; Deploy then provisions the target environment.
export const projectChanges = pgTable(
	"project_changes",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: projectRef(),
		// The environment a change targets; NULL = project-level config (the default).
		environment_id: uuid().references(() => projectEnvironments.id, {
			onDelete: "cascade",
		}),
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Canvas node kind (database, cache, cluster, …) the change applies to.
		component_type: text().notNull(),
		// Target component row for UPDATE/DELETE; NULL for CREATE.
		component_id: uuid(),
		op: changeOp().notNull(),
		// The desired component config for CREATE/UPDATE (a cloud-indifferent delta).
		payload: jsonb().$type<StagedChangePayload>(),
		created_at: ts(),
	},
	(t) => [index("idx_project_changes_project").on(t.project_id)],
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
