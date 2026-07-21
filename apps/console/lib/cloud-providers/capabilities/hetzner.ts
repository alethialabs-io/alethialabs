// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner capability enumeration (epic #928, lane #937). Token cloud: decrypts the stored project token
// (the one non-keyless path; Hetzner has no role federation). Reads what THIS project can launch: its
// locations and, per location, the server types with a tri-state `launchable` verdict.
//
// Hetzner's `/datacenters` is the authoritative launch signal (generalizing the shipped fleet
// `serverTypeAvailabilityFromTypes`): `server_types.available[]` = creatable NOW ⇒ launchable;
// `server_types.supported[]` minus available = offered but capacity-blocked ⇒ not_launchable. There is no
// queryable project quota (the resource limit only surfaces reactively as a 403 on create), so the quota
// DIMENSION is not_evaluable — but availability itself gives a real launch verdict. Availability is
// design-time GUIDANCE, never a hard gate; best-effort, never throws.

import { getServiceDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto/secrets";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../inventory/upsert";
import {
	existingNativeIds,
	hashSource,
	recordRegionHashes,
	regionDue,
} from "./sync-state";
import type { CapabilityIdentity } from "./types";

const HCLOUD_API = "https://api.hetzner.cloud/v1";
const TIMEOUT_MS = 15_000;
const PER_PAGE = 50;
const MAX_PAGES = 200;

interface HcloudServerType {
	id?: number;
	name?: string;
	cores?: number;
	memory?: number; // GB
	architecture?: string; // "x86" | "arm"
}
interface HcloudDatacenter {
	location?: { name?: string };
	server_types?: { available?: number[]; supported?: number[] };
}
interface HcloudLocation {
	name?: string;
}

async function api(path: string, token: string): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${HCLOUD_API}${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`hcloud HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Paginate a hcloud list endpoint, accumulating `body[key]` across pages (bounded, strict progress). */
async function listAll<T>(
	resource: string,
	key: string,
	token: string,
): Promise<T[]> {
	const out: T[] = [];
	let page = 1;
	for (let i = 0; i < MAX_PAGES; i++) {
		const body = await api(`/${resource}?per_page=${PER_PAGE}&page=${page}`, token);
		if (!isRecord(body)) break;
		const items = body[key];
		if (Array.isArray(items)) out.push(...items);
		let next: number | null = null;
		if (isRecord(body.meta) && isRecord(body.meta.pagination)) {
			const n = body.meta.pagination.next_page;
			if (typeof n === "number") next = n;
		}
		if (next === null || next <= page) break;
		page = next;
	}
	return out;
}

/** Family from a server-type name: strip the trailing size digits (`cax21` → `cax`, `cpx31` → `cpx`). */
function familyOf(name: string): string {
	return name.replace(/[0-9].*$/, "") || name;
}

/** Decrypt the stored Hetzner project token (multi-key, mirrors the inventory token path). */
function tokenFor(identity: CapabilityIdentity): string | null {
	const enc = identity.credentials.token;
	if (!enc) return null;
	const decoded = decryptSecret(enc);
	return decoded.api_token ?? decoded.token ?? Object.values(decoded)[0] ?? null;
}

/** Enumerate this Hetzner project's launchable locations + server types into the capability tables. */
export async function syncHetznerCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const token = tokenFor(identity);
	if (!token) return;
	const db = getServiceDb();
	const identityId = identity.id;

	// Locations = regions.
	const locations = await listAll<HcloudLocation>("locations", "locations", token);
	const regionNames = locations
		.map((l) => l.name)
		.filter((n): n is string => Boolean(n));

	const seenRegions: string[] = [];
	for (const region of regionNames) {
		seenRegions.push(region);
		const now = new Date();
		await db
			.insert(cloudCapabilityRegions)
			.values({
				cloud_identity_id: identityId,
				provider: "hetzner",
				region,
				native_id: region,
				name: region,
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

	// Server-type specs (id → name/vcpu/mem/family/arch).
	const serverTypes = await listAll<HcloudServerType>(
		"server_types",
		"server_types",
		token,
	);
	const specById = new Map<number, HcloudServerType>();
	for (const st of serverTypes) {
		if (typeof st.id === "number") specById.set(st.id, st);
	}

	// Per location: available (launchable now) vs supported (offered, may be capacity-blocked).
	const datacenters = await listAll<HcloudDatacenter>(
		"datacenters",
		"datacenters",
		token,
	);
	const byRegion = new Map<
		string,
		{ available: Set<number>; supported: Set<number> }
	>();
	for (const dc of datacenters) {
		const region = dc.location?.name;
		if (!region) continue;
		if (!byRegion.has(region))
			byRegion.set(region, { available: new Set(), supported: new Set() });
		const agg = byRegion.get(region);
		if (!agg) continue;
		for (const id of dc.server_types?.available ?? []) agg.available.add(id);
		for (const id of dc.server_types?.supported ?? []) agg.supported.add(id);
	}

	const seenTypes: string[] = [];
	for (const [region, agg] of byRegion) {
		// The available + supported server-type sets are the launch signal. Hetzner exposes no queryable
		// project quota, so there is no quota axis — gate on instance_types only.
		const instanceHash = hashSource({
			available: agg.available,
			supported: agg.supported,
		});
		if (
			!(await regionDue({
				cloudIdentityId: identityId,
				provider: "hetzner",
				region,
				instanceHash,
			}))
		) {
			seenTypes.push(...(await existingNativeIds(identityId, region)));
			continue;
		}
		const now = new Date();
		const rows = [...agg.supported].flatMap((id) => {
			const spec = specById.get(id);
			if (!spec?.name) return [];
			seenTypes.push(spec.name);
			const isAvailable = agg.available.has(id);
			const launchable: CapabilityLaunchable = isAvailable
				? "launchable"
				: "not_launchable";
			const reason: CapabilityLaunchableReason = isAvailable
				? "available"
				: "capacity_blocked";
			return [
				{
					cloud_identity_id: identityId,
					provider: "hetzner" as const,
					region,
					native_id: spec.name,
					name: spec.name,
					vcpu: spec.cores ?? null,
					mem_gb: typeof spec.memory === "number" ? spec.memory : null,
					family: familyOf(spec.name),
					arch: spec.architecture ?? null,
					launchable,
					launchable_reason: reason,
					last_seen: now,
					last_synced_at: now,
					removed_at: null,
				},
			];
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
			provider: "hetzner",
			region,
			instanceHash,
		});
	}
	await softRemoveUnseen("cloud_capability_instance_types", identityId, seenTypes);
}
