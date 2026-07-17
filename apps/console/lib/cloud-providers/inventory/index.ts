// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Inventory dispatcher — runs a connection's asset sync by provider and stamps `inventory_synced_at`.
// All six providers are wired (AWS/Azure/GCP networks+subnets; token clouds regions); the
// reconciliation sweep + event ingester both route through here. Best-effort: an inventory failure
// never fails the connect — the sweep retries.

import { eq, lt, sql } from "drizzle-orm";
import { numOr } from "@/lib/coerce";
import { asRecord } from "@/lib/records";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	type CloudProvider,
	cloudCaches,
	cloudContainerRegistries,
	cloudDatabases,
	cloudDnsZones,
	cloudIdentities,
	cloudKubernetesClusters,
	cloudNetworks,
	cloudNics,
	cloudNosqlTables,
	cloudQueues,
	cloudRegions,
	cloudResources,
	cloudSecrets,
	cloudStorageBuckets,
	cloudSubnets,
	cloudTopics,
} from "@/lib/db/schema";
import { syncAlibabaInventory } from "./alibaba";
import { syncAwsInventory } from "./aws";
import { syncAzureInventory } from "./azure";
import { syncGcpInventory } from "./gcp";
import { syncTokenCloudInventory } from "./tokencloud";

/** Every inventory table — for whole-connection purge + retention GC. Children (subnets/nics) list
 * before parents so FK cascades never block a delete. */
const INVENTORY_TABLES = [
	cloudNics,
	cloudSubnets,
	cloudNetworks,
	cloudRegions,
	cloudDnsZones,
	cloudKubernetesClusters,
	cloudDatabases,
	cloudCaches,
	cloudQueues,
	cloudTopics,
	cloudNosqlTables,
	cloudContainerRegistries,
	cloudSecrets,
	cloudStorageBuckets,
	cloudResources,
] as const;

const TOKEN_CLOUDS = new Set(["digitalocean", "hetzner", "civo"]);

/** Whether a provider has a server-side inventory sync yet. */
export function hasServerSideInventory(provider: CloudProvider): boolean {
	return (
		provider === "aws" ||
		provider === "azure" ||
		provider === "gcp" ||
		provider === "alibaba" ||
		TOKEN_CLOUDS.has(provider)
	);
}

/** Syncs one connection's inventory (by provider) and stamps `inventory_synced_at`. Never throws. */
export async function syncCloudInventory(
	identity: Pick<CloudIdentity, "id" | "provider" | "credentials">,
): Promise<void> {
	try {
		if (identity.provider === "aws") {
			await syncAwsInventory(identity);
		} else if (identity.provider === "azure") {
			await syncAzureInventory(identity);
		} else if (identity.provider === "gcp") {
			await syncGcpInventory(identity);
		} else if (identity.provider === "alibaba") {
			await syncAlibabaInventory(identity);
		} else if (TOKEN_CLOUDS.has(identity.provider)) {
			await syncTokenCloudInventory(identity);
		} else {
			return;
		}
		await getServiceDb()
			.update(cloudIdentities)
			.set({ inventory_synced_at: new Date() })
			.where(eq(cloudIdentities.id, identity.id));
	} catch {
		// Best-effort — the periodic reconciliation sweep retries.
	}
}

/** Purges a connection's entire stored inventory (called on disconnect — we keep no projection of a
 * cloud we no longer have access to). */
export async function purgeCloudInventory(cloudIdentityId: string): Promise<void> {
	const db = getServiceDb();
	for (const table of INVENTORY_TABLES) {
		await db.delete(table).where(eq(table.cloud_identity_id, cloudIdentityId));
	}
}

/** Garbage-collects soft-removed rows (a resource deleted in-cloud) older than the retention window
 * across every connection. Runs from the sweep. Returns rows purged. */
export async function gcRemovedInventory(retentionDays: number): Promise<number> {
	const db = getServiceDb();
	const cutoff = sql`now() - make_interval(days => ${retentionDays})`;
	let purged = 0;
	for (const table of INVENTORY_TABLES) {
		const res = await db
			.delete(table)
			.where(lt(table.removed_at, cutoff as never));
		purged += numOr(asRecord(res).rowCount, 0);
	}
	return purged;
}
