// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Event ingester — applies ONE normalized cloud change event to the asset inventory (the near-real-time
// path beneath the reconciliation sweep). A provider's webhook route parses its raw event into a
// `NormalizedCloudEvent` and calls `applyCloudEvent`, which upserts (create/update) or soft-removes
// (delete) the matching typed row. Same tables as the sweep, so the two stay consistent.

import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { sealSensitive } from "@/lib/cloud-providers/inventory/upsert";
import {
	type CloudIdentity,
	cloudDnsZones,
	cloudKubernetesClusters,
	cloudNetworks,
	cloudRegions,
	cloudSubnets,
} from "@/lib/db/schema";
import type { CloudInventoryAttributes } from "@/types/jsonb.types";

/** The inventory kinds the event ingester maps today (the canvas/elench hot path). */
export type CloudEventKind =
	| "region"
	| "network"
	| "subnet"
	| "dns_zone"
	| "kubernetes_cluster";

/** A provider-agnostic change event — the shape each provider's webhook normalizes its raw event to. */
export interface NormalizedCloudEvent {
	kind: CloudEventKind;
	/** The provider-native resource id (vpc-…, /subscriptions/…/…, …). */
	native_id: string;
	region?: string | null;
	name?: string | null;
	attributes?: CloudInventoryAttributes;
	/** True for a delete event → the row is soft-removed instead of upserted. */
	deleted?: boolean;
}

/**
 * Applies one normalized change event to a connection's inventory. Typed per-kind (concrete tables)
 * so it stays type-safe; the common-column payload is shared. Only the canvas/elench hot-path kinds
 * are mapped today — others arrive via the reconciliation sweep until added here.
 */
export async function applyCloudEvent(
	cloudIdentityId: string,
	provider: CloudIdentity["provider"],
	event: NormalizedCloudEvent,
): Promise<void> {
	const db = getServiceDb();
	const now = new Date();
	// Seal any reconnaissance-sensitive attr the event carries (e.g. a CIDR) into the encrypted blob;
	// never persist raw attributes. Most forwarders send only {kind, native_id, region, name}.
	const cidr = event.attributes?.cidr_block;
	const sensitive = sealSensitive({
		cidr_block: typeof cidr === "string" ? cidr : undefined,
	});
	const common = {
		cloud_identity_id: cloudIdentityId,
		provider,
		region: event.region ?? null,
		native_id: event.native_id,
		name: event.name ?? null,
		sensitive,
		first_seen: now,
		last_seen: now,
		last_synced_at: now,
		removed_at: null,
	};
	const updateSet = {
		region: event.region ?? null,
		name: event.name ?? null,
		sensitive,
		last_seen: now,
		last_synced_at: now,
		removed_at: null,
	};

	switch (event.kind) {
		case "region":
			if (event.deleted) {
				await db
					.update(cloudRegions)
					.set({ removed_at: now })
					.where(
						and(
							eq(cloudRegions.cloud_identity_id, cloudIdentityId),
							eq(cloudRegions.native_id, event.native_id),
						),
					);
				return;
			}
			await db
				.insert(cloudRegions)
				.values(common)
				.onConflictDoUpdate({
					target: [
						cloudRegions.cloud_identity_id,
						cloudRegions.provider,
						cloudRegions.native_id,
					],
					set: updateSet,
				});
			return;
		case "network":
			if (event.deleted) {
				await db
					.update(cloudNetworks)
					.set({ removed_at: now })
					.where(
						and(
							eq(cloudNetworks.cloud_identity_id, cloudIdentityId),
							eq(cloudNetworks.native_id, event.native_id),
						),
					);
				return;
			}
			await db
				.insert(cloudNetworks)
				.values(common)
				.onConflictDoUpdate({
					target: [
						cloudNetworks.cloud_identity_id,
						cloudNetworks.provider,
						cloudNetworks.native_id,
					],
					set: updateSet,
				});
			return;
		case "subnet":
			if (event.deleted) {
				await db
					.update(cloudSubnets)
					.set({ removed_at: now })
					.where(
						and(
							eq(cloudSubnets.cloud_identity_id, cloudIdentityId),
							eq(cloudSubnets.native_id, event.native_id),
						),
					);
				return;
			}
			await db
				.insert(cloudSubnets)
				.values(common)
				.onConflictDoUpdate({
					target: [
						cloudSubnets.cloud_identity_id,
						cloudSubnets.provider,
						cloudSubnets.native_id,
					],
					set: updateSet,
				});
			return;
		case "dns_zone":
			if (event.deleted) {
				await db
					.update(cloudDnsZones)
					.set({ removed_at: now })
					.where(
						and(
							eq(cloudDnsZones.cloud_identity_id, cloudIdentityId),
							eq(cloudDnsZones.native_id, event.native_id),
						),
					);
				return;
			}
			await db
				.insert(cloudDnsZones)
				.values(common)
				.onConflictDoUpdate({
					target: [
						cloudDnsZones.cloud_identity_id,
						cloudDnsZones.provider,
						cloudDnsZones.native_id,
					],
					set: updateSet,
				});
			return;
		case "kubernetes_cluster":
			if (event.deleted) {
				await db
					.update(cloudKubernetesClusters)
					.set({ removed_at: now })
					.where(
						and(
							eq(cloudKubernetesClusters.cloud_identity_id, cloudIdentityId),
							eq(cloudKubernetesClusters.native_id, event.native_id),
						),
					);
				return;
			}
			await db
				.insert(cloudKubernetesClusters)
				.values(common)
				.onConflictDoUpdate({
					target: [
						cloudKubernetesClusters.cloud_identity_id,
						cloudKubernetesClusters.provider,
						cloudKubernetesClusters.native_id,
					],
					set: updateSet,
				});
			return;
	}
}
