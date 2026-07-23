// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CloudCapabilityProvider seam (epic #928 / wave:capabilities). One `sync<Cloud>Capabilities`
// per cloud enumerates what THIS account can launch (regions + instance-types in Wave-1) by assuming
// the customer's keyless session/* identity, calling read-only Describe/List APIs, normalizing to the
// cloud_capability_* rows, and upserting via the service role. Each lane fills in its own stub
// (capabilities/<cloud>.ts); the dispatcher (capabilities/index.ts) is pre-wired to all five so lanes
// never touch the shared dispatch file. Structural contract (matches the inventory lanes): never throw
// (best-effort; the refresh sweep retries), stamp `capabilities_synced_at` in the dispatcher.

import type {
	CapabilityLaunchable,
	CapabilityLaunchableReason,
	CapabilityQuotaKind,
	CapabilityServiceKind,
	CloudCapabilityInstanceType,
	CloudCapabilityInstanceTypeInsert,
	CloudCapabilityQuota,
	CloudCapabilityQuotaInsert,
	CloudCapabilityRegion,
	CloudCapabilityRegionInsert,
	CloudCapabilityService,
	CloudCapabilityServiceInsert,
	CloudIdentity,
} from "@/lib/db/schema";

export type {
	CapabilityLaunchable,
	CapabilityLaunchableReason,
	CapabilityQuotaKind,
	CapabilityServiceKind,
	CloudCapabilityInstanceType,
	CloudCapabilityInstanceTypeInsert,
	CloudCapabilityQuota,
	CloudCapabilityQuotaInsert,
	CloudCapabilityRegion,
	CloudCapabilityRegionInsert,
	CloudCapabilityService,
	CloudCapabilityServiceInsert,
};

/** The subset of a cloud_identity a capability lane needs: its id (row scoping), provider (dispatch),
 * and credentials (the keyless session/* assume). Identical to the inventory lanes' input. */
export type CapabilityIdentity = Pick<
	CloudIdentity,
	"id" | "provider" | "credentials"
>;

/** The one Wave-1 method every cloud implements. Enumerates + upserts this account's launchable regions
 * + instance types. MUST be best-effort (never throw) — the dispatcher stamps freshness only after it
 * resolves. */
export type SyncCapabilities = (
	identity: CapabilityIdentity,
) => Promise<void>;

/** The Wave-2 method every cloud implements: enumerates + upserts this account's launchable managed
 * SERVICES (DB engines+versions, cache tiers, managed-Kubernetes versions, NoSQL availability) into
 * `cloud_capability_services`. Same structural contract as `SyncCapabilities` — best-effort, never
 * throws; the services dispatcher stamps freshness only after it resolves. */
export type SyncServiceCapabilities = (
	identity: CapabilityIdentity,
) => Promise<void>;

/** The quota-axis method a cloud implements (#981): enumerates this account's networking service-quota
 * HEADROOM (EIP / NAT-gateway / load-balancer / security-group limits + used/available) into
 * `cloud_capability_quotas`. Same structural contract as `SyncCapabilities` — best-effort, never throws;
 * the dispatcher stamps freshness only after it resolves. Seam pre-wired here (#1115); the lanes land in
 * #981. */
export type SyncQuotaCapabilities = (
	identity: CapabilityIdentity,
) => Promise<void>;
