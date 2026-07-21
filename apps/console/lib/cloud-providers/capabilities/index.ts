// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Capabilities dispatcher (epic #928 / wave:capabilities) — runs a connection's capability enumeration
// by provider and stamps `capabilities_synced_at`. Pre-wired to all five capability lanes (aws/azure/
// gcp/alibaba/hetzner) so the per-cloud lanes only edit their own file. The refresh sweep (#938) + the
// on-connect hook route through here. Best-effort: an enumeration failure never fails the connect — the
// sweep retries. Mirrors inventory/index.ts.
//
// Wave-1 enumerates regions + instance-types. `capabilities_synced_at` doubles as the change-detection
// dirty sentinel: a Tier-2 invalidation event (#978) NULLs it so the next sweep tick re-enumerates.

import { eq, sql } from "drizzle-orm";
import { numOr } from "@/lib/coerce";
import { asRecord } from "@/lib/records";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	type CloudProvider,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
	cloudIdentities,
} from "@/lib/db/schema";
import { syncAlibabaCapabilities } from "./alibaba";
import { syncAwsCapabilities } from "./aws";
import { syncAzureCapabilities } from "./azure";
import { syncGcpCapabilities } from "./gcp";
import { syncHetznerCapabilities } from "./hetzner";

/** Every capability table — for whole-connection purge (on disconnect) + retention GC. */
const CAPABILITY_TABLES = [
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
] as const;

/** Whether a provider has a capability enumeration lane. Wave-1 covers the five clouds with a lane;
 * the other token clouds (digitalocean/civo) have no capability enumeration yet. */
export function hasServerSideCapabilities(provider: CloudProvider): boolean {
	return (
		provider === "aws" ||
		provider === "azure" ||
		provider === "gcp" ||
		provider === "alibaba" ||
		provider === "hetzner"
	);
}

/** Enumerates one connection's launchable offerings (by provider) and stamps `capabilities_synced_at`.
 * Never throws — best-effort; the refresh sweep retries. */
export async function syncCloudCapabilities(
	identity: Pick<CloudIdentity, "id" | "provider" | "credentials">,
): Promise<void> {
	try {
		if (identity.provider === "aws") {
			await syncAwsCapabilities(identity);
		} else if (identity.provider === "azure") {
			await syncAzureCapabilities(identity);
		} else if (identity.provider === "gcp") {
			await syncGcpCapabilities(identity);
		} else if (identity.provider === "alibaba") {
			await syncAlibabaCapabilities(identity);
		} else if (identity.provider === "hetzner") {
			await syncHetznerCapabilities(identity);
		} else {
			return;
		}
		await getServiceDb()
			.update(cloudIdentities)
			.set({ capabilities_synced_at: new Date() })
			.where(eq(cloudIdentities.id, identity.id));
	} catch {
		// Best-effort — the periodic capability refresh sweep retries.
	}
}

/** Purges a connection's entire capabilities catalog (called on disconnect — we keep no projection of
 * a cloud we no longer have access to). */
export async function purgeCloudCapabilities(
	cloudIdentityId: string,
): Promise<void> {
	const db = getServiceDb();
	for (const table of CAPABILITY_TABLES) {
		await db.delete(table).where(eq(table.cloud_identity_id, cloudIdentityId));
	}
}

/** Garbage-collects soft-removed capability rows (an offering withdrawn in-cloud) older than the
 * retention window across every connection. Runs from the refresh sweep. Returns rows purged. */
export async function gcRemovedCapabilities(
	retentionDays: number,
): Promise<number> {
	const db = getServiceDb();
	const cutoff = sql`now() - make_interval(days => ${retentionDays})`;
	let purged = 0;
	for (const table of CAPABILITY_TABLES) {
		const res = await db
			.delete(table)
			.where(sql`${table.removed_at} < ${cutoff}`);
		purged += numOr(asRecord(res).rowCount, 0);
	}
	return purged;
}
