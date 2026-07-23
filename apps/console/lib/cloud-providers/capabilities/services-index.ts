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
// Per-cloud lanes (#972–976): each enumerates its account's launchable managed services keyless
// (session → SDK/REST → normalize → upsert into `cloud_capability_services`) and is best-effort
// (syncCloudServiceCapabilities below swallows a lane error; the refresh sweep retries).
import { syncAlibabaServiceCapabilities } from "./services/alibaba";
import { syncAwsServiceCapabilities } from "./services/aws";
import { syncAzureServiceCapabilities } from "./services/azure";
import { syncGcpServiceCapabilities } from "./services/gcp";
import { syncHetznerServiceCapabilities } from "./services/hetzner";
import type { CapabilityIdentity } from "./types";

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
