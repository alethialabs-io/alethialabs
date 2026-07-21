// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure capability enumeration (epic #928, lane #934). Authenticates AS the customer's managed identity
// (keyless) and reads what THIS subscription can launch: its physical locations and, per location, the
// offerable VM sizes with a tri-state `launchable` verdict.
//
// Azure is the strongest account-accurate signal of all clouds: `Microsoft.Compute/skus` returns, in ONE
// subscription-wide call, each SKU's per-location `restrictions[]` (empty ⇒ launchable; reasonCode
// `NotAvailableForSubscription` / `QuotaId` ⇒ not deployable), and `Compute usages` per location gives the
// per-VM-family core `limit` (0 ⇒ quota_zero). We AND them: a SKU can be unrestricted yet have a family
// limit of 0 → still unlaunchable. Availability is design-time GUIDANCE, never a hard gate; best-effort.

import { getServiceDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
	type CapabilityLaunchable,
	type CapabilityLaunchableReason,
	cloudCapabilityInstanceTypes,
	cloudCapabilityRegions,
} from "@/lib/db/schema";
import { assumeAzureIdentity } from "../session/azure";
import { softRemoveUnseen } from "../inventory/upsert";
import {
	existingNativeIds,
	hashSource,
	recordRegionHashes,
	regionDue,
} from "./sync-state";
import type { CapabilityIdentity } from "./types";

const TIMEOUT_MS = 15_000;
const ARM = "https://management.azure.com";
const MAX_PAGES = 200;

/** Acquires an ARM bearer token as the customer managed identity (keyless), or throws. */
async function azureToken(tenantId: string, clientId: string): Promise<string> {
	const cred = assumeAzureIdentity(tenantId, clientId);
	const t = await cred.getToken("https://management.azure.com/.default");
	if (!t?.token) throw new Error("Azure token acquisition returned no token");
	return t.token;
}

async function armGet<T>(url: string, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Azure ARM HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

interface AzureLocation {
	name?: string;
	displayName?: string;
	metadata?: { regionType?: string };
}
interface AzureSkuRestriction {
	type?: string; // "Location" | "Zone"
	values?: string[];
	reasonCode?: string; // "QuotaId" | "NotAvailableForSubscription"
	restrictionInfo?: { locations?: string[] };
}
interface AzureSku {
	resourceType?: string;
	name?: string;
	family?: string;
	locations?: string[];
	capabilities?: { name?: string; value?: string }[];
	restrictions?: AzureSkuRestriction[];
}
interface AzureUsage {
	name?: { value?: string };
	currentValue?: number;
	limit?: number;
}

/** Follow ARM `nextLink` pagination, accumulating `value[]`. */
async function armList<T>(firstUrl: string, token: string): Promise<T[]> {
	const out: T[] = [];
	let url: string | undefined = firstUrl;
	for (let i = 0; i < MAX_PAGES && url; i++) {
		const page: { value?: T[]; nextLink?: string } = await armGet(url, token);
		out.push(...(page.value ?? []));
		url = page.nextLink;
	}
	return out;
}

/** The reason a SKU is restricted in a given location, or null if unrestricted there. */
function restrictionReason(
	sku: AzureSku,
	location: string,
): CapabilityLaunchableReason | null {
	for (const r of sku.restrictions ?? []) {
		if (r.type !== "Location") continue;
		const locs = r.restrictionInfo?.locations ?? r.values ?? [];
		if (!locs.includes(location)) continue;
		return r.reasonCode === "NotAvailableForSubscription"
			? "not_available_for_subscription"
			: "sku_restricted";
	}
	return null;
}

function capString(sku: AzureSku, name: string): string | null {
	return (sku.capabilities ?? []).find((x) => x.name === name)?.value ?? null;
}

function capNumber(sku: AzureSku, name: string): number | null {
	const v = capString(sku, name);
	if (v === null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Enumerate this Azure subscription's launchable regions + VM sizes into the capability tables. */
export async function syncAzureCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const subscriptionId = identity.credentials.subscription_id;
	const tenantId = identity.credentials.tenant_id;
	const clientId = identity.credentials.client_id;
	if (!subscriptionId || !tenantId || !clientId) return;

	const token = await azureToken(tenantId, clientId);
	const db = getServiceDb();
	const identityId = identity.id;

	// Physical locations the subscription can use.
	const locations = await armList<AzureLocation>(
		`${ARM}/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
		token,
	);
	const regionNames = locations
		.filter((l) => l.metadata?.regionType !== "Logical")
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
				provider: "azure",
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

	// All VM SKUs (one subscription-wide call), grouped by the enabled locations they list.
	const skus = (
		await armList<AzureSku>(
			`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01`,
			token,
		)
	).filter(
		(s): s is AzureSku & { name: string } =>
			s.resourceType === "virtualMachines" && Boolean(s.name),
	);

	const seenTypes: string[] = [];
	for (const region of regionNames) {
		// Per-family core limit (0 ⇒ quota_zero). Family names match the SKU `family` field.
		const usages = await armList<AzureUsage>(
			`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${region}/usages?api-version=2023-07-01`,
			token,
		);
		const familyLimit = new Map<string, number>();
		for (const u of usages) {
			if (u.name?.value && typeof u.limit === "number") {
				familyLimit.set(u.name.value, u.limit);
			}
		}

		// The set of SKUs offered in this location + the per-family core limits gate the upsert.
		const offeredNames = new Set(
			skus
				.filter((s) => (s.locations ?? []).includes(region))
				.map((s) => s.name),
		);
		const instanceHash = hashSource(offeredNames);
		const quotaHash = hashSource(familyLimit);
		if (
			!(await regionDue({
				cloudIdentityId: identityId,
				provider: "azure",
				region,
				instanceHash,
				quotaHash,
			}))
		) {
			seenTypes.push(...(await existingNativeIds(identityId, region)));
			continue;
		}

		const now = new Date();
		const rows = skus
			.filter((s) => (s.locations ?? []).includes(region))
			.map((sku) => {
				const name = sku.name;
				seenTypes.push(name);
				const restricted = restrictionReason(sku, region);
				const limit = sku.family ? familyLimit.get(sku.family) : undefined;
				let launchable: CapabilityLaunchable;
				let reason: CapabilityLaunchableReason;
				if (restricted) {
					launchable = "not_launchable";
					reason = restricted;
				} else if (limit !== undefined && limit <= 0) {
					launchable = "not_launchable";
					reason = "quota_zero";
				} else {
					launchable = "launchable";
					reason = "available";
				}
				return {
					cloud_identity_id: identityId,
					provider: "azure" as const,
					region,
					native_id: name,
					name,
					vcpu: capNumber(sku, "vCPUs"),
					mem_gb: capNumber(sku, "MemoryGB"),
					family: sku.family ?? null,
					arch: capString(sku, "CpuArchitectureType"),
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
			provider: "azure",
			region,
			instanceHash,
			quotaHash,
		});
	}
	await softRemoveUnseen("cloud_capability_instance_types", identityId, seenTypes);
}
