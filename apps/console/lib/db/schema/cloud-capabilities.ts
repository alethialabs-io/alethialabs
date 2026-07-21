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

export type CloudCapabilityRegion = typeof cloudCapabilityRegions.$inferSelect;
export type CloudCapabilityRegionInsert =
	typeof cloudCapabilityRegions.$inferInsert;
export type CloudCapabilityInstanceType =
	typeof cloudCapabilityInstanceTypes.$inferSelect;
export type CloudCapabilityInstanceTypeInsert =
	typeof cloudCapabilityInstanceTypes.$inferInsert;
export type CloudCapabilitySyncState =
	typeof cloudCapabilitySyncState.$inferSelect;
export type CloudCapabilitySyncStateInsert =
	typeof cloudCapabilitySyncState.$inferInsert;
