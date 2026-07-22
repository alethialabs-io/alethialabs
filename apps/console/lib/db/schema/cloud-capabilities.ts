// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-tenant cloud CAPABILITIES catalog (epic #928 / wave:capabilities) — the account-accurate picture
// of what a connected cloud account CAN LAUNCH (distinct from cloud-inventory.ts, which is what it
// already HAS, and from the static packages/core/catalog + lib/cloud-providers constants, which are a
// curated GLOBAL offer). Populated by the per-cloud capability enumeration lanes (assume the customer's
// keyless session/* identity → read-only Describe/List → normalize), refreshed by a change-detector
// sweep, and read by the design-canvas pickers with fail-open fallback to the static catalog.
//
// Same tenancy shape as the inventory tables: every row is FK'd to a `cloud_identity`, and RLS scopes
// reads through that parent (registered in the programmables.sql `owner_all` loop; no trigger). Writes
// come from the server-side sync via the service role. Availability is GUIDANCE, never a hard gate.
//
// Wave-1 covers regions + instance-types; the managed-service axes (DB/cache/k8s versions, NoSQL) land
// in the Wave-2 `cloud_capability_services` table (a separate seams extension).

import {
	index,
	integer,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import {
	capabilityLaunchable,
	capabilityLaunchableReason,
	capabilitySyncAxis,
	cloudProvider,
} from "./enums";
import { cloudIdentities } from "./identities";

const ts = () => timestamp({ withTimezone: true }).defaultNow().notNull();

// The managed-service axis a `cloud_capability_services` row describes (Wave-2, epic #928). A finite,
// provider-neutral discriminator (per the finite-known-values-are-enums rule) — each row is exactly one
// kind, and the queries fall back to the matching static Catalog #2 slice per kind. Kept inline here
// (not enums.ts) because it is owned entirely by this Wave-2 seams extension; drizzle-kit scans every
// schema file for enums, so an inline `pgEnum` registers the same as a centralized one.
export const capabilityServiceKind = pgEnum("capability_service_kind", [
	"database", // a managed relational DB engine + offered version (RDS/Aurora, Cloud SQL, Azure DB, ApsaraDB, CloudNativePG)
	"cache", // a managed in-memory cache tier/node class (ElastiCache, Memorystore, Azure Cache, ApsaraDB Redis)
	"kubernetes", // an offered managed-Kubernetes control-plane version (EKS/GKE/AKS/ACK; Hetzner = pinned Talos)
	"nosql", // account availability of the cloud's NoSQL service (DynamoDB/Firestore/Cosmos DB/Tablestore)
]);
export type CapabilityServiceKind =
	(typeof capabilityServiceKind.enumValues)[number];

// The networking service-quota a `cloud_capability_quotas` row measures headroom for (#981 axis; seams
// #1115). A finite, provider-neutral discriminator (per the finite-known-values-are-enums rule) — each
// row measures exactly one kind, and the picker degrades to advisory when the used/available figures are
// not knowable. Kept inline here (not enums.ts) for the same reason as capabilityServiceKind above.
export const capabilityQuotaKind = pgEnum("capability_quota_kind", [
	"elastic_ip", // account/region elastic-IP (EIP) address limit (AWS EIPs, GCP static IPs, Azure public IPs, Alibaba EIPs)
	"nat_gateway", // NAT gateway count limit per region/VPC
	"load_balancer", // load-balancer count limit (ELB/ALB/NLB, GCP forwarding rules, Azure LB, Alibaba SLB)
	"security_group", // security-group (or equivalent firewall-policy) count limit
]);
export type CapabilityQuotaKind =
	(typeof capabilityQuotaKind.enumValues)[number];

/** The columns every capability row shares — a factory (not a shared object) so each table gets fresh
 * drizzle column builders. Mirrors inventoryBase() (cloud-inventory.ts) but WITHOUT the AES-GCM
 * `sensitive` blob: an account's offerings (region codes, instance-type names/specs) are not
 * reconnaissance-sensitive. `cloud_identity_id` is what the RLS policy joins through. */
const capabilityBase = () => ({
	id: uuid().primaryKey().defaultRandom(),
	cloud_identity_id: uuid()
		.notNull()
		.references(() => cloudIdentities.id, { onDelete: "cascade" }),
	provider: cloudProvider().notNull(),
	// The cloud region/location this capability row is scoped to. For a region row this equals
	// `native_id`; for an instance-type row it is the region the type is offered in (rows recur per region).
	region: text(),
	// The provider-native identifier (region code, or instance/machine/server-type name). Unique per
	// identity (+ region, for the per-region axes).
	native_id: text().notNull(),
	name: text(),
	first_seen: ts(),
	last_seen: ts(),
	last_synced_at: ts(),
	// Soft-removal: set when a refresh no longer sees the offering (or a dirty-event re-enumeration drops it).
	removed_at: timestamp({ withTimezone: true }),
});

// ── Regions the account has ENABLED ─────────────────────────────────────────────────
// AWS opt-in regions, Azure locations, GCP regions, Alibaba regions, Hetzner locations. Presence of a
// non-removed row = the account can deploy there. `native_id` = the provider region code.
export const cloudCapabilityRegions = pgTable(
	"cloud_capability_regions",
	{ ...capabilityBase() },
	(t) => [
		unique("cloud_capability_regions_identity_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.native_id,
		),
		index("idx_cloud_capability_regions_identity").on(t.cloud_identity_id),
	],
);

// ── Instance / machine / server types offerable PER REGION ──────────────────────────
// A direct generalization of the Hetzner `serverTypeAvailabilityFromTypes` map to all clouds. The same
// type recurs per region, so `region` is part of the unique key. `launchable` is the tri-state
// account-accurate verdict (availability ∧ quota where knowable); `launchable_reason` is its normalized,
// bounded reason. Specs (vcpu/mem/family/arch) let the picker show "N options for your account".
export const cloudCapabilityInstanceTypes = pgTable(
	"cloud_capability_instance_types",
	{
		...capabilityBase(),
		vcpu: integer(),
		// GB of memory; numeric because some types are fractional (e.g. n1-standard-1 = 3.75 GB).
		mem_gb: numeric({ precision: 8, scale: 2, mode: "number" }),
		// Coarse family/class (e.g. "t3", "Standard", "N2", "cax") — the grain AWS quota is knowable at.
		family: text(),
		// CPU architecture ("x86_64" / "arm64") where the provider reports it.
		arch: text(),
		launchable: capabilityLaunchable().notNull().default("not_evaluable"),
		launchable_reason: capabilityLaunchableReason(),
	},
	(t) => [
		// Region is IN the key: the same instance type is a distinct offering per region.
		unique("cloud_capability_instance_types_identity_region_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.region,
			t.native_id,
		),
		index("idx_cloud_capability_instance_types_identity").on(t.cloud_identity_id),
	],
);

// ── Managed-SERVICE offerings PER REGION (Wave-2) ───────────────────────────────────
// One table for every managed-service axis (discriminated by `service_kind`): the DB engines+versions,
// cache engines+tiers, managed-Kubernetes versions, and NoSQL availability THIS account can launch —
// the service-level generalization of the instance-types table. `native_id` is the provider-native id
// per kind: the engine value ("aurora-postgresql"), cache node class ("cache.t3.medium"), k8s version
// string ("1.35"), or NoSQL service name ("DynamoDB"). The same offering recurs per region, so `region`
// is part of the unique key (account-wide axes like NoSQL populate it with a real region code — never
// NULL — so the unique key doesn't trip Postgres's "NULLs are distinct" rule on upsert, exactly as the
// instance-types + sync-state tables do). `launchable`/`launchable_reason` carry the same tri-state
// account-accurate verdict; availability is design-time GUIDANCE, never a hard gate (#918 fail-open).
export const cloudCapabilityServices = pgTable(
	"cloud_capability_services",
	{
		...capabilityBase(),
		service_kind: capabilityServiceKind().notNull(),
		// The engine/family this offering belongs to, where the kind has one: DB engine family
		// ("aurora-postgresql", "postgres"), cache engine ("redis"). NULL for k8s/nosql (no engine axis).
		engine: text(),
		// The offered version, where the kind is versioned: DB engine version ("16.6") or managed-k8s
		// control-plane version ("1.35"). NULL for cache/nosql.
		version: text(),
		// Coarse tier/capacity class for the `cache` kind (the node class label) — NULL for other kinds.
		tier: text(),
		// GB of memory for a `cache` tier where the provider reports it; numeric because some are fractional.
		mem_gb: numeric({ precision: 8, scale: 2, mode: "number" }),
		launchable: capabilityLaunchable().notNull().default("not_evaluable"),
		launchable_reason: capabilityLaunchableReason(),
	},
	(t) => [
		// (identity, provider, region, service-kind, native_id) — the same engine/version/tier is a
		// distinct offering per region and per kind.
		unique("cloud_capability_services_identity_region_kind_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.region,
			t.service_kind,
			t.native_id,
		),
		index("idx_cloud_capability_services_identity").on(t.cloud_identity_id),
		index("idx_cloud_capability_services_identity_kind").on(
			t.cloud_identity_id,
			t.service_kind,
		),
	],
);

// ── Change-detection state — the Tier-1 hash gate (#938) ────────────────────────────
// One row per (identity, provider, axis, region): the hash of that slice's cheap SOURCE signal at its last
// full enumeration. The refresh sweep re-runs a lane; the lane recomputes the cheap signature (offered-type
// set / launch quota) and, if the stored hash still matches AND the axis's TTL hasn't lapsed, SKIPS the
// expensive per-region work (AWS `DescribeInstanceTypes`; a batch upsert on the account-wide clouds). This
// is a control table, NOT part of the tenant-facing catalog — but it FKs to `cloud_identity`, so it rides
// the same `owner_all` RLS loop (programmables.sql). `region` is NOT NULL (both Wave-1 axes are per-region);
// a real value keeps the unique key from tripping Postgres's "NULLs are distinct" rule under onConflict.
export const cloudCapabilitySyncState = pgTable(
	"cloud_capability_sync_state",
	{
		id: uuid().primaryKey().defaultRandom(),
		cloud_identity_id: uuid()
			.notNull()
			.references(() => cloudIdentities.id, { onDelete: "cascade" }),
		provider: cloudProvider().notNull(),
		axis: capabilitySyncAxis().notNull(),
		region: text().notNull(),
		// Deterministic sha256 of the axis's cheap source signal at the last successful enumeration.
		source_hash: text().notNull(),
		hashed_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("cloud_capability_sync_state_identity_axis_region_key").on(
			t.cloud_identity_id,
			t.provider,
			t.axis,
			t.region,
		),
		index("idx_cloud_capability_sync_state_identity").on(t.cloud_identity_id),
	],
);

// ── Service-quota HEADROOM offerable PER REGION — the quota axis (#981; seams #1115) ───────────────
// The account-accurate "how many more can you launch" picture for the networking quotas a provision plan
// consumes. One row per (identity, provider, region, quota_kind, native_id): `native_id` is the provider
// quota code (e.g. AWS `L-0263D0A3` for EIPs); `quota_limit`/`used`/`available` carry the headroom, each
// NULL when the plan/provider can't report it (honest `not_evaluable`, not a fabricated zero). Shares the
// capabilityBase() shape (cloud_identity_id FK, soft-removal) so it rides the identical `owner_all` RLS
// loop (programmables.sql) and the retention GC. Availability is GUIDANCE — the picker renders low headroom
// as advisory, never a hard gate.
export const cloudCapabilityQuotas = pgTable(
	"cloud_capability_quotas",
	{
		...capabilityBase(),
		quota_kind: capabilityQuotaKind().notNull(),
		// The provider-reported quota ceiling for this kind in this region; NULL when not knowable.
		quota_limit: integer(),
		// Currently consumed against the ceiling; NULL when not knowable.
		used: integer(),
		// Remaining headroom (ceiling − used) where the provider reports it directly; NULL when not knowable.
		available: integer(),
	},
	(t) => [
		// quota_kind + native_id are BOTH in the key: a kind can span several provider quota codes, and the
		// same code recurs per region as a distinct offering.
		unique("cloud_capability_quotas_identity_region_kind_native_key").on(
			t.cloud_identity_id,
			t.provider,
			t.region,
			t.quota_kind,
			t.native_id,
		),
		index("idx_cloud_capability_quotas_identity").on(t.cloud_identity_id),
	],
);

export type CloudCapabilityRegion = typeof cloudCapabilityRegions.$inferSelect;
export type CloudCapabilityRegionInsert =
	typeof cloudCapabilityRegions.$inferInsert;
export type CloudCapabilityInstanceType =
	typeof cloudCapabilityInstanceTypes.$inferSelect;
export type CloudCapabilityInstanceTypeInsert =
	typeof cloudCapabilityInstanceTypes.$inferInsert;
export type CloudCapabilityService =
	typeof cloudCapabilityServices.$inferSelect;
export type CloudCapabilityServiceInsert =
	typeof cloudCapabilityServices.$inferInsert;
export type CloudCapabilitySyncState =
	typeof cloudCapabilitySyncState.$inferSelect;
export type CloudCapabilitySyncStateInsert =
	typeof cloudCapabilitySyncState.$inferInsert;
export type CloudCapabilityQuota = typeof cloudCapabilityQuotas.$inferSelect;
export type CloudCapabilityQuotaInsert =
	typeof cloudCapabilityQuotas.$inferInsert;
