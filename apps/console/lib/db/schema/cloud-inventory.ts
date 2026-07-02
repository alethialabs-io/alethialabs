// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloud asset inventory — the server-side, always-fresh picture of what EXISTS in a connected cloud
// account (replaces the per-account `cached_resources` JSONB blob). Populated by the console's
// inventory sync (initial + reconciliation sweep) and the near-real-time event ingester, never by a
// runner. The resource universe is bounded (~the component/abstract model), so the kinds we reason
// about are TYPED tables with uniform cross-cloud columns + a provider-nuance `attributes` JSONB; a
// thin generic `cloud_resources` catch-all keeps drift coverage for anything not yet typed.
//
// Every row is scoped to a `cloud_identity` and identified by its provider-native id; freshness columns
// (`first_seen`/`last_seen`/`last_synced_at`) + soft `removed_at` let the canvas offer existing
// resources and elench diff designed-vs-existing for drift.

import {
	boolean,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { cloudProvider } from "./enums";
import { cloudIdentities } from "./identities";

const ts = () => timestamp({ withTimezone: true }).defaultNow().notNull();

/** The columns every inventory row shares. A factory (not a shared object) so each table gets fresh
 * drizzle column builders.
 *
 * Data-custody note: only low-sensitivity IDENTIFIERS are plaintext (native_id, name, region + the
 * typed low-sensitivity attributes per table). Anything that describes topology in a
 * reconnaissance-useful way — CIDRs, private/public IPs, endpoints, DNS domains — goes into the
 * `sensitive` blob, which is AES-GCM encrypted at rest (see `types/jsonb.types.ts CloudSensitiveAttrs`
 * + the encrypt-on-write / decrypt-on-read in inventory/upsert + the reader). We never store raw
 * resource tags. The cloud is the source of truth; this is a minimized, expiring projection. */
const inventoryBase = () => ({
	id: uuid().primaryKey().defaultRandom(),
	cloud_identity_id: uuid()
		.notNull()
		.references(() => cloudIdentities.id, { onDelete: "cascade" }),
	provider: cloudProvider().notNull(),
	// NULL for global resources (e.g. IAM, some DNS); else the cloud region/location.
	region: text(),
	// The provider-native resource id (vpc-…, /subscriptions/…/…, projects/…/…). Unique per identity.
	native_id: text().notNull(),
	name: text(),
	// AES-GCM ciphertext of the sensitive attributes for this row (CIDRs/IPs/endpoints/domains), or NULL.
	sensitive: text(),
	first_seen: ts(),
	last_seen: ts(),
	last_synced_at: ts(),
	// Soft-removal: set when a sweep no longer sees the resource (or an event deletes it).
	removed_at: timestamp({ withTimezone: true }),
});

// ── Regions ──────────────────────────────────────────────────────────────────────
export const cloudRegions = pgTable(
	"cloud_regions",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_regions_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_regions_identity").on(t.cloud_identity_id),
	],
);

// ── Networking ────────────────────────────────────────────────────────────────────
export const cloudNetworks = pgTable(
	"cloud_networks",
	{
		...inventoryBase(),
		is_default: boolean().default(false),
	},
	(t) => [
		unique("cloud_networks_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_networks_identity").on(t.cloud_identity_id),
	],
);

export const cloudSubnets = pgTable(
	"cloud_subnets",
	{
		...inventoryBase(),
		// FK to the owning network row (NULL until the parent is synced).
		network_id: uuid().references(() => cloudNetworks.id, { onDelete: "cascade" }),
		availability_zone: text(),
		is_public: boolean().default(false),
	},
	(t) => [
		unique("cloud_subnets_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_subnets_identity").on(t.cloud_identity_id),
		index("idx_cloud_subnets_network").on(t.network_id),
	],
);

export const cloudNics = pgTable(
	"cloud_nics",
	{
		...inventoryBase(),
		subnet_id: uuid().references(() => cloudSubnets.id, { onDelete: "set null" }),
	},
	(t) => [
		unique("cloud_nics_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_nics_identity").on(t.cloud_identity_id),
	],
);

export const cloudDnsZones = pgTable(
	"cloud_dns_zones",
	{
		...inventoryBase(),
		is_private: boolean().default(false),
	},
	(t) => [
		unique("cloud_dns_zones_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_dns_zones_identity").on(t.cloud_identity_id),
	],
);

// ── Compute / managed services (mirror the abstract component model) ────────────────
export const cloudKubernetesClusters = pgTable(
	"cloud_kubernetes_clusters",
	{
		...inventoryBase(),
		version: text(),
		network_id: uuid().references(() => cloudNetworks.id, { onDelete: "set null" }),
	},
	(t) => [
		unique("cloud_kubernetes_clusters_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_kubernetes_clusters_identity").on(t.cloud_identity_id),
	],
);

export const cloudDatabases = pgTable(
	"cloud_databases",
	{
		...inventoryBase(),
		// Cloud-indifferent engine family ("postgres" | "mysql"), mirroring projectDatabases.
		engine_family: text(),
		engine: text(),
		engine_version: text(),
	},
	(t) => [
		unique("cloud_databases_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_databases_identity").on(t.cloud_identity_id),
	],
);

export const cloudCaches = pgTable(
	"cloud_caches",
	{
		...inventoryBase(),
		engine: text(),
		engine_version: text(),
		memory_gb: numeric({ precision: 8, scale: 2, mode: "number" }),
	},
	(t) => [
		unique("cloud_caches_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_caches_identity").on(t.cloud_identity_id),
	],
);

export const cloudQueues = pgTable(
	"cloud_queues",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_queues_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_queues_identity").on(t.cloud_identity_id),
	],
);

export const cloudTopics = pgTable(
	"cloud_topics",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_topics_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_topics_identity").on(t.cloud_identity_id),
	],
);

export const cloudNosqlTables = pgTable(
	"cloud_nosql_tables",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_nosql_tables_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_nosql_tables_identity").on(t.cloud_identity_id),
	],
);

export const cloudContainerRegistries = pgTable(
	"cloud_container_registries",
	{
		...inventoryBase(),
	},
	(t) => [
		unique("cloud_container_registries_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_container_registries_identity").on(t.cloud_identity_id),
	],
);

export const cloudSecrets = pgTable(
	"cloud_secrets",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_secrets_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_secrets_identity").on(t.cloud_identity_id),
	],
);

export const cloudStorageBuckets = pgTable(
	"cloud_storage_buckets",
	{ ...inventoryBase() },
	(t) => [
		unique("cloud_storage_buckets_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_storage_buckets_identity").on(t.cloud_identity_id),
	],
);

// ── Generic catch-all ───────────────────────────────────────────────────────────────
// Anything not yet typed (keeps drift/event coverage without a migration per stray kind).
export const cloudResources = pgTable(
	"cloud_resources",
	{
		...inventoryBase(),
		// The resource kind (provider-native type string, e.g. "AWS::EC2::NatGateway").
		kind: text().notNull(),
		// Optional native id of a parent resource (for tree-shaped inventories).
		parent_native_id: text(),
	},
	(t) => [
		unique("cloud_resources_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_resources_identity").on(t.cloud_identity_id),
		index("idx_cloud_resources_kind").on(t.cloud_identity_id, t.kind),
	],
);

export type CloudRegion = typeof cloudRegions.$inferSelect;
export type CloudNetwork = typeof cloudNetworks.$inferSelect;
export type CloudSubnet = typeof cloudSubnets.$inferSelect;
export type CloudNic = typeof cloudNics.$inferSelect;
export type CloudDnsZone = typeof cloudDnsZones.$inferSelect;
export type CloudKubernetesCluster = typeof cloudKubernetesClusters.$inferSelect;
export type CloudDatabase = typeof cloudDatabases.$inferSelect;
export type CloudCache = typeof cloudCaches.$inferSelect;
export type CloudResourceRow = typeof cloudResources.$inferSelect;
