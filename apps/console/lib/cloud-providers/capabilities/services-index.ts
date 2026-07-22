// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managed-SERVICE capabilities dispatcher (Wave-2, epic #928 / wave:capabilities) — the service-axis
// twin of index.ts. Where Wave-1 enumerates regions + instance-types, Wave-2 enumerates what managed
// SERVICES this account can launch (DB engines+versions, cache tiers, managed-Kubernetes versions, NoSQL
// availability) into `cloud_capability_services`. Pre-wired to all five capability clouds (aws/azure/gcp/
// alibaba/hetzner) so the per-cloud enumeration waves only fill in their own stub below and never touch
// this shared dispatch file. Structural contract mirrors index.ts: best-effort (an enumeration failure
// never fails the caller — the refresh sweep retries).
//
// SEAMS: the per-cloud `sync<Cloud>ServiceCapabilities` functions are no-op stubs today (Wave-2 lands the
// table + dispatch seam; the real Describe/List enumeration per cloud is a follow-up lane). Until a lane
// is implemented, the queries in lib/queries/capabilities.ts fail open to the static Catalog #2, so the
// pickers are correct (just not yet account-accurate) for the service axes.

import { eq, sql } from "drizzle-orm";
import { numOr } from "@/lib/coerce";
import { getServiceDb } from "@/lib/db";
import {
	type CloudProvider,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import { asRecord } from "@/lib/records";
import type { CapabilityIdentity, SyncServiceCapabilities } from "./types";

// ── Per-cloud stubs (SEAMS) ─────────────────────────────────────────────────────────
// Each is a best-effort no-op until its enumeration lane is implemented. They live inline here rather
// than in the per-cloud lane files so the Wave-2 seam is self-contained; a lane wave replaces the body
// with the real keyless Describe/List → normalize → upsert into `cloud_capability_services`.

/** AWS managed-service capabilities: RDS/Aurora engines+versions, ElastiCache node classes, EKS
 * versions, DynamoDB availability. Stub — enumeration lands in a follow-up lane. */
const syncAwsServiceCapabilities: SyncServiceCapabilities = async () => {};

/** Azure managed-service capabilities: Azure DB engines+versions, Azure Cache tiers, AKS versions,
 * Cosmos DB availability. Stub — enumeration lands in a follow-up lane. */
const syncAzureServiceCapabilities: SyncServiceCapabilities = async () => {};

/** GCP managed-service capabilities: Cloud SQL engines+versions, Memorystore tiers, GKE versions,
 * Firestore availability. Stub — enumeration lands in a follow-up lane. */
const syncGcpServiceCapabilities: SyncServiceCapabilities = async () => {};

/** Alibaba managed-service capabilities: ApsaraDB RDS engines+versions, ApsaraDB Redis tiers, ACK
 * versions, Tablestore availability. Stub — enumeration lands in a follow-up lane. */
const syncAlibabaServiceCapabilities: SyncServiceCapabilities = async () => {};

/** Hetzner managed-service capabilities: CloudNativePG Postgres, the pinned Talos-coupled Kubernetes
 * version (no managed cache/NoSQL). Stub — enumeration lands in a follow-up lane. */
const syncHetznerServiceCapabilities: SyncServiceCapabilities = async () => {};

/** Whether a provider has a managed-service capability enumeration lane. Matches the Wave-1 lane set
 * (the five clouds with a `cloud_capability_*` lane); token clouds without one return false. */
export function hasServerSideServiceCapabilities(
	provider: CloudProvider,
): boolean {
	return (
		provider === "aws" ||
		provider === "azure" ||
		provider === "gcp" ||
		provider === "alibaba" ||
		provider === "hetzner"
	);
}

/** Enumerates one connection's launchable managed SERVICES (by provider) into
 * `cloud_capability_services`. Never throws — best-effort; the refresh sweep retries. */
export async function syncCloudServiceCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	try {
		if (identity.provider === "aws") {
			await syncAwsServiceCapabilities(identity);
		} else if (identity.provider === "azure") {
			await syncAzureServiceCapabilities(identity);
		} else if (identity.provider === "gcp") {
			await syncGcpServiceCapabilities(identity);
		} else if (identity.provider === "alibaba") {
			await syncAlibabaServiceCapabilities(identity);
		} else if (identity.provider === "hetzner") {
			await syncHetznerServiceCapabilities(identity);
		}
	} catch {
		// Best-effort — the periodic capability refresh sweep retries.
	}
}

/** Purges a connection's entire managed-service capabilities catalog (called on disconnect — we keep no
 * projection of a cloud we no longer have access to). Parallels index.ts's purgeCloudCapabilities. */
export async function purgeCloudServiceCapabilities(
	cloudIdentityId: string,
): Promise<void> {
	await getServiceDb()
		.delete(cloudCapabilityServices)
		.where(eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId));
}

/** Garbage-collects soft-removed service-capability rows (an offering withdrawn in-cloud) older than the
 * retention window across every connection. Runs from the refresh sweep. Returns rows purged. */
export async function gcRemovedServiceCapabilities(
	retentionDays: number,
): Promise<number> {
	const cutoff = sql`now() - make_interval(days => ${retentionDays})`;
	const res = await getServiceDb()
		.delete(cloudCapabilityServices)
		.where(sql`${cloudCapabilityServices.removed_at} < ${cutoff}`);
	return numOr(asRecord(res).rowCount, 0);
}
