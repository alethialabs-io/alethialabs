// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Networking service-quota (headroom) capabilities dispatcher (#981 axis; wired by #1180) — the
// quota-axis twin of services-index.ts. Where the services dispatcher enumerates WHAT managed services
// an account can launch, this enumerates HOW MANY MORE of the networking quotas a provision plan
// consumes (elastic-IP / NAT-gateway / load-balancer / security-group limits + used/available) the
// account still has headroom for, into `cloud_capability_quotas`. Pre-wired to the four managed clouds
// with a quota lane; hetzner is a documented exclusion (a token cloud with no queryable networking
// service-quota API). Structural contract mirrors services-index.ts: best-effort (a lane failure never
// fails the caller — the refresh sweep retries).

import { eq, sql } from "drizzle-orm";
import { numOr } from "@/lib/coerce";
import { getServiceDb } from "@/lib/db";
import { type CloudProvider, cloudCapabilityQuotas } from "@/lib/db/schema";
import { asRecord } from "@/lib/records";
// Per-cloud lanes (#981): each enumerates its account's networking service-quota headroom keyless
// (session → SDK → normalize → upsert into `cloud_capability_quotas`) and is best-effort
// (syncCloudQuotaCapabilities below swallows a lane error; the refresh sweep retries).
import { syncAlibabaQuotaCapabilities } from "./service-quotas/alibaba";
import { syncAwsQuotaCapabilities } from "./service-quotas/aws";
import { syncAzureQuotaCapabilities } from "./service-quotas/azure";
import { syncGcpQuotaCapabilities } from "./service-quotas/gcp";
import type { CapabilityIdentity } from "./types";

/** Whether a provider has a networking service-quota enumeration lane. The four managed clouds do;
 * hetzner is a documented exclusion (a token cloud with no queryable service-quota API). */
export function hasServerSideQuotaCapabilities(provider: CloudProvider): boolean {
	return (
		provider === "aws" ||
		provider === "azure" ||
		provider === "gcp" ||
		provider === "alibaba"
	);
}

/** Enumerates one connection's networking service-quota HEADROOM (by provider) into
 * `cloud_capability_quotas`. Never throws — best-effort; the refresh sweep retries. */
export async function syncCloudQuotaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	try {
		if (identity.provider === "aws") {
			await syncAwsQuotaCapabilities(identity);
		} else if (identity.provider === "azure") {
			await syncAzureQuotaCapabilities(identity);
		} else if (identity.provider === "gcp") {
			await syncGcpQuotaCapabilities(identity);
		} else if (identity.provider === "alibaba") {
			await syncAlibabaQuotaCapabilities(identity);
		}
	} catch {
		// Best-effort — the periodic capability refresh sweep retries.
	}
}

/** Purges a connection's entire service-quota capabilities catalog (called on disconnect — we keep no
 * projection of a cloud we no longer have access to). Parallels purgeCloudServiceCapabilities. */
export async function purgeCloudQuotaCapabilities(
	cloudIdentityId: string,
): Promise<void> {
	await getServiceDb()
		.delete(cloudCapabilityQuotas)
		.where(eq(cloudCapabilityQuotas.cloud_identity_id, cloudIdentityId));
}

/** Garbage-collects soft-removed quota-capability rows (a quota withdrawn/retired in-cloud) older than
 * the retention window across every connection. Runs from the refresh sweep. Returns rows purged. */
export async function gcRemovedQuotaCapabilities(
	retentionDays: number,
): Promise<number> {
	const cutoff = sql`now() - make_interval(days => ${retentionDays})`;
	const res = await getServiceDb()
		.delete(cloudCapabilityQuotas)
		.where(sql`${cloudCapabilityQuotas.removed_at} < ${cutoff}`);
	return numOr(asRecord(res).rowCount, 0);
}
