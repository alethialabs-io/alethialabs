// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP capability enumeration (epic #928, lane #935). Mints a WIF token AS the customer (keyless) and reads
// what THIS project can launch: its regions and, per region, the offerable machine types with a tri-state
// `launchable` verdict.
//
// launchable = "offered" AND "has quota". `machineTypes.aggregatedList` gives the offered types per zone;
// `regions.list` returns each region's `quotas[]` (metric → limit) for the CLASSIC per-family vCPU metrics
// (CPUS, N2_CPUS, C2_CPUS, …). We map a machine type's family to its metric: limit 0 ⇒ quota_zero, >0 ⇒
// launchable. Modern families (N4/C4/Z3/…) are consolidated under a dimensioned metric NOT exposed in
// `regions.quotas[]` (it needs the Cloud Quotas API), so those stay `not_evaluable`/`quota_unknown` — honest,
// never a fabricated verdict. Availability is design-time GUIDANCE, never a hard gate; best-effort, never throws.

import { getServiceDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { externalAccountClientFromWif } from "../session/gcp";
import { softRemoveUnseen } from "../inventory/upsert";
import {
	existingNativeIds,
	hashSource,
	recordRegionHashes,
	regionDue,
} from "./sync-state";
import type { CapabilityIdentity } from "./types";

const TIMEOUT_MS = 15_000;
const COMPUTE = "https://compute.googleapis.com/compute/v1";

/** Mints a GCP access token from the connection's stored WIF config, or throws. */
async function gcpToken(identity: CapabilityIdentity): Promise<string> {
	const wif = identity.credentials.wif_config;
	if (!wif) throw new Error("No GCP WIF config");
	const client = externalAccountClientFromWif(wif);
	if (!client) throw new Error("Retired AWS-hub GCP setup — reconnect it.");
	const at = await client.getAccessToken();
	if (!at.token) throw new Error("GCP token acquisition returned no token");
	return at.token;
}

async function gcpGet<T>(url: string, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`GCP API HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

interface GcpRegion {
	name?: string;
	status?: string;
	quotas?: { metric?: string; limit?: number }[];
}
interface GcpMachineType {
	name?: string;
	guestCpus?: number;
	memoryMb?: number;
	zone?: string;
	deprecated?: { state?: string };
}

// Classic per-family vCPU quota metrics exposed on the region resource. Families NOT listed here
// (modern N4/C4/Z3/… under the dimensioned CPUS_PER_VM_FAMILY metric) resolve to `not_evaluable`.
const FAMILY_METRIC: Record<string, string> = {
	e2: "CPUS", // shared aggregate with N1/F1/G1
	n1: "CPUS",
	f1: "CPUS",
	g1: "CPUS",
	n2: "N2_CPUS",
	n2d: "N2D_CPUS",
	c2: "C2_CPUS",
	c2d: "C2D_CPUS",
	a2: "A2_CPUS",
	a3: "A3_CPUS",
	m1: "M1_CPUS",
	m2: "M2_CPUS",
	m3: "M3_CPUS",
	t2d: "T2D_CPUS",
	t2a: "T2A_CPUS",
};

/** Region name from a zone name/URL: `us-central1-a` → `us-central1`. */
function regionOfZone(zone: string): string {
	const short = zone.split("/").pop() ?? zone;
	return short.replace(/-[a-z]$/, "");
}

function verdictFor(
	family: string,
	metricLimits: Map<string, number>,
): { launchable: CapabilityLaunchable; reason: CapabilityLaunchableReason } {
	const metric = FAMILY_METRIC[family];
	const limit = metric ? metricLimits.get(metric) : undefined;
	if (limit === undefined)
		return { launchable: "not_evaluable", reason: "quota_unknown" };
	if (limit <= 0) return { launchable: "not_launchable", reason: "quota_zero" };
	return { launchable: "launchable", reason: "available" };
}

/** Enumerate this GCP project's launchable regions + machine types into the capability tables. */
export async function syncGcpCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const projectId = identity.credentials.project_id;
	if (!projectId) return;
	const token = await gcpToken(identity);
	const db = getServiceDb();
	const identityId = identity.id;

	// Regions + their classic per-family vCPU quota limits.
	const regionsResp = await gcpGet<{ items?: GcpRegion[] }>(
		`${COMPUTE}/projects/${projectId}/regions`,
		token,
	);
	const quotaByRegion = new Map<string, Map<string, number>>();
	const seenRegions: string[] = [];
	for (const r of regionsResp.items ?? []) {
		if (!r.name) continue;
		seenRegions.push(r.name);
		const limits = new Map<string, number>();
		for (const q of r.quotas ?? []) {
			if (q.metric && typeof q.limit === "number") limits.set(q.metric, q.limit);
		}
		quotaByRegion.set(r.name, limits);
		const now = new Date();
		await db
			.insert(cloudCapabilityRegions)
			.values({
				cloud_identity_id: identityId,
				provider: "gcp",
				region: r.name,
				native_id: r.name,
				name: r.name,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			})
			.onConflictDoUpdate({
				target: [
					cloudCapabilityRegions.cloud_identity_id,
					cloudCapabilityRegions.provider,
					cloudCapabilityRegions.native_id,
				],
				set: { last_seen: now, last_synced_at: now, removed_at: null },
			});
	}
	await softRemoveUnseen("cloud_capability_regions", identityId, seenRegions);

	// Machine types (aggregated across zones) → one row per (region, type).
	const machineResp = await gcpGet<{
		items?: Record<string, { machineTypes?: GcpMachineType[] }>;
	}>(`${COMPUTE}/projects/${projectId}/aggregated/machineTypes`, token);

	// region → (typeName → row) so a type offered in several zones of a region is deduped.
	const byRegion = new Map<string, Map<string, GcpMachineType>>();
	for (const scope of Object.values(machineResp.items ?? {})) {
		for (const mt of scope.machineTypes ?? []) {
			if (!mt.name || !mt.zone) continue;
			if (mt.deprecated?.state === "OBSOLETE" || mt.deprecated?.state === "DELETED")
				continue;
			const region = regionOfZone(mt.zone);
			if (!byRegion.has(region)) byRegion.set(region, new Map());
			const forRegion = byRegion.get(region);
			if (forRegion && !forRegion.has(mt.name)) forRegion.set(mt.name, mt);
		}
	}

	const seenTypes: string[] = [];
	for (const [region, types] of byRegion) {
		const metricLimits = quotaByRegion.get(region) ?? new Map<string, number>();
		// The offered machine-type set + the region's classic quota limits gate the per-region upsert.
		const instanceHash = hashSource(new Set(types.keys()));
		const quotaHash = hashSource(metricLimits);
		if (
			!(await regionDue({
				cloudIdentityId: identityId,
				provider: "gcp",
				region,
				instanceHash,
				quotaHash,
			}))
		) {
			seenTypes.push(...(await existingNativeIds(identityId, region)));
			continue;
		}
		const now = new Date();
		const rows = [...types].map(([name, mt]) => {
			seenTypes.push(name);
			const family = name.split("-")[0] || "";
			const { launchable, reason } = verdictFor(family, metricLimits);
			return {
				cloud_identity_id: identityId,
				provider: "gcp" as const,
				region,
				native_id: name,
				name,
				vcpu: mt.guestCpus ?? null,
				mem_gb:
					typeof mt.memoryMb === "number"
						? Math.round((mt.memoryMb / 1024) * 100) / 100
						: null,
				family: family || null,
				arch: null,
				launchable,
				launchable_reason: reason,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			};
		});

		if (rows.length > 0) {
			await db
				.insert(cloudCapabilityInstanceTypes)
				.values(rows)
				.onConflictDoUpdate({
					target: [
						cloudCapabilityInstanceTypes.cloud_identity_id,
						cloudCapabilityInstanceTypes.provider,
						cloudCapabilityInstanceTypes.region,
						cloudCapabilityInstanceTypes.native_id,
					],
					set: {
						name: sql`excluded.name`,
						vcpu: sql`excluded.vcpu`,
						mem_gb: sql`excluded.mem_gb`,
						family: sql`excluded.family`,
						arch: sql`excluded.arch`,
						launchable: sql`excluded.launchable`,
						launchable_reason: sql`excluded.launchable_reason`,
						last_seen: sql`excluded.last_seen`,
						last_synced_at: sql`excluded.last_synced_at`,
						removed_at: sql`excluded.removed_at`,
					},
				});
		}
		await recordRegionHashes({
			cloudIdentityId: identityId,
			provider: "gcp",
			region,
			instanceHash,
			quotaHash,
		});
	}
	await softRemoveUnseen("cloud_capability_instance_types", identityId, seenTypes);
}
