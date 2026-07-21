// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Tier-1 change-detection gate for the capability lanes (epic #928 / #938). A lane always fetches the
// CHEAP source signals for a region (the offered-type set, the launch quota) — those ARE the change signal —
// then asks `regionDue` whether anything moved before doing the EXPENSIVE work (AWS `DescribeInstanceTypes`
// per region; a batch upsert on the account-wide clouds). A slice is due when its stored `source_hash`
// changed, when its axis TTL lapsed, or when it was never enumerated. On a run, the lane records BOTH axes'
// hashes; on a skip it records nothing (so the TTL backstop still eventually fires on a permanently-stable
// slice) but MUST fold the region's already-stored types back into the sweep's `seen` set — `softRemoveUnseen`
// keys on `native_id` GLOBALLY per identity (ignores region), so a type offered only in a skipped region
// would otherwise be wrongly soft-removed. Availability stays design-time GUIDANCE, never a hard gate.
//
// Best-effort, like the lanes: a DB hiccup here fails OPEN (treat the slice as due / record nothing) so a
// transient error re-enumerates next tick rather than freezing a stale hash. Reads/writes go through the
// service role; RLS is enforced on the tenant-facing READ path (lib/queries/capabilities.ts), not here.

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilitySyncAxis,
	type CloudProvider,
	cloudCapabilityInstanceTypes,
	cloudCapabilitySyncState,
} from "@/lib/db/schema";

/** The offered-type catalog is near-static — a 24h outer backstop under the hash gate. */
export const INSTANCE_TYPES_TTL_MS = 24 * 60 * 60 * 1000;
/** Quota moves on a limit-increase ticket and flips a verdict, so it re-evaluates on a shorter sub-TTL. */
export const QUOTA_TTL_MS = 6 * 60 * 60 * 1000;

/** Recursively normalize a value so equal content hashes equally regardless of key / Set / Map order:
 * Sets → sorted arrays, Maps → key-sorted entry pairs, object keys sorted. Arrays keep their order
 * (callers that care pass a stable order; the lanes pass Sets/Maps, which we sort here). */
function normalize(value: unknown): unknown {
	if (value instanceof Set) {
		return [...value].map(normalize).sort(compare);
	}
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([k, v]) => [k, normalize(v)])
			.sort((a, b) => compare(a[0], b[0]));
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value).sort((a, b) =>
			compare(a[0], b[0]),
		)) {
			sorted[key] = normalize(v);
		}
		return sorted;
	}
	return value;
}

/** Stable total order for normalize's sorts (numbers and strings compare by their string form). */
function compare(a: unknown, b: unknown): number {
	const sa = String(a);
	const sb = String(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Deterministic sha256 hex of any JSON-able source signal (Set/Map order-independent). */
export function hashSource(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(normalize(input)))
		.digest("hex");
}

/** Whether one axis of a region is due: no prior row, hash changed, or the TTL lapsed. Fails OPEN (due). */
async function axisDue(args: {
	cloudIdentityId: string;
	provider: CloudProvider;
	axis: CapabilitySyncAxis;
	region: string;
	sourceHash: string;
	ttlMs: number;
}): Promise<boolean> {
	try {
		const [row] = await getServiceDb()
			.select({
				source_hash: cloudCapabilitySyncState.source_hash,
				hashed_at: cloudCapabilitySyncState.hashed_at,
			})
			.from(cloudCapabilitySyncState)
			.where(
				and(
					eq(cloudCapabilitySyncState.cloud_identity_id, args.cloudIdentityId),
					eq(cloudCapabilitySyncState.provider, args.provider),
					eq(cloudCapabilitySyncState.axis, args.axis),
					eq(cloudCapabilitySyncState.region, args.region),
				),
			)
			.limit(1);
		if (!row) return true; // never enumerated
		if (row.source_hash !== args.sourceHash) return true; // the source moved
		return Date.now() - row.hashed_at.getTime() > args.ttlMs; // TTL backstop
	} catch {
		return true; // fail open — re-enumerate rather than freeze a stale hash
	}
}

/** Records one axis's hash (upsert on the unique slice key), stamping `hashed_at`. Best-effort. */
async function recordAxisHash(args: {
	cloudIdentityId: string;
	provider: CloudProvider;
	axis: CapabilitySyncAxis;
	region: string;
	sourceHash: string;
}): Promise<void> {
	try {
		const now = new Date();
		await getServiceDb()
			.insert(cloudCapabilitySyncState)
			.values({
				cloud_identity_id: args.cloudIdentityId,
				provider: args.provider,
				axis: args.axis,
				region: args.region,
				source_hash: args.sourceHash,
				hashed_at: now,
			})
			.onConflictDoUpdate({
				target: [
					cloudCapabilitySyncState.cloud_identity_id,
					cloudCapabilitySyncState.provider,
					cloudCapabilitySyncState.axis,
					cloudCapabilitySyncState.region,
				],
				set: { source_hash: args.sourceHash, hashed_at: now },
			});
	} catch {
		// Best-effort: a missed record just means the slice re-enumerates next tick (fail open).
	}
}

/** A region's launchable-offerings slice is due if EITHER its instance-type source or (where the cloud
 * exposes quota) its quota source moved / lapsed its TTL. Pass `quotaHash: undefined` for a cloud with no
 * queryable quota (Hetzner) — that axis is then never checked. */
export async function regionDue(args: {
	cloudIdentityId: string;
	provider: CloudProvider;
	region: string;
	instanceHash: string;
	quotaHash?: string;
}): Promise<boolean> {
	const instanceDue = await axisDue({
		cloudIdentityId: args.cloudIdentityId,
		provider: args.provider,
		axis: "instance_types",
		region: args.region,
		sourceHash: args.instanceHash,
		ttlMs: INSTANCE_TYPES_TTL_MS,
	});
	if (instanceDue) return true;
	if (args.quotaHash === undefined) return false;
	return axisDue({
		cloudIdentityId: args.cloudIdentityId,
		provider: args.provider,
		axis: "quota",
		region: args.region,
		sourceHash: args.quotaHash,
		ttlMs: QUOTA_TTL_MS,
	});
}

/** Records BOTH axes' hashes after a successful region enumeration (quota only where the cloud has it).
 * Always record both on any run, so a quota-triggered pass also advances the instance-type TTL (else the
 * instance-type backstop would re-trip on every quota tick). */
export async function recordRegionHashes(args: {
	cloudIdentityId: string;
	provider: CloudProvider;
	region: string;
	instanceHash: string;
	quotaHash?: string;
}): Promise<void> {
	await recordAxisHash({
		cloudIdentityId: args.cloudIdentityId,
		provider: args.provider,
		axis: "instance_types",
		region: args.region,
		sourceHash: args.instanceHash,
	});
	if (args.quotaHash !== undefined) {
		await recordAxisHash({
			cloudIdentityId: args.cloudIdentityId,
			provider: args.provider,
			axis: "quota",
			region: args.region,
			sourceHash: args.quotaHash,
		});
	}
}

/** The non-removed instance-type `native_id`s currently stored for one (identity, region). A SKIPPED
 * region feeds these into the sweep's `seen` set so the global-per-identity `softRemoveUnseen` doesn't
 * wrongly remove a type offered only there. Fails open to [] (worst case: a spurious soft-remove, healed
 * next enumeration). */
export async function existingNativeIds(
	cloudIdentityId: string,
	region: string,
): Promise<string[]> {
	try {
		const rows = await getServiceDb()
			.select({ native_id: cloudCapabilityInstanceTypes.native_id })
			.from(cloudCapabilityInstanceTypes)
			.where(
				and(
					eq(cloudCapabilityInstanceTypes.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityInstanceTypes.region, region),
					isNull(cloudCapabilityInstanceTypes.removed_at),
				),
			);
		return rows.map((r) => r.native_id).filter((n): n is string => Boolean(n));
	} catch {
		return [];
	}
}
