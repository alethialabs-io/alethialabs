// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure service-quota headroom enumeration (Wave-2 quota axis, epic #928, #981). Authenticates AS the
// customer's managed identity (keyless, session/azure) and reads, per location, the networking usages —
// current vs limit — from the Microsoft.Network usages ARM endpoint. Unlike AWS, Azure reports BOTH the
// limit and current usage, so `used`/`available` are populated. Best-effort: never throws; a failing
// location is skipped.
//
// DOCUMENTED per-cloud parity gap: the Microsoft.Network/locations/usages response does NOT include NAT
// gateways (confirmed against the full documented example) — NAT-gateway headroom lives under the newer
// Microsoft.Quota provider, a separate wiring. So Azure covers elastic_ip / load_balancer / security_group
// here; nat_gateway is an explicit exclusion (not a silent omission — cloud parity is a hard rule).

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CapabilityQuotaKind,
	cloudCapabilityQuotas,
} from "@/lib/db/schema";
import { softRemoveUnseen } from "../../inventory/upsert";
import { assumeAzureIdentity } from "../../session/azure";
import type { CapabilityIdentity } from "../types";

const ARM = "https://management.azure.com";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 200;
const API_LOCATIONS = "2022-12-01";
const API_NETWORK_USAGES = "2024-05-01";

// Microsoft.Network usage `name.value` → the quota kind it measures headroom for.
const AZURE_USAGE_KINDS: Record<string, CapabilityQuotaKind> = {
	PublicIPAddresses: "elastic_ip",
	LoadBalancers: "load_balancer",
	NetworkSecurityGroups: "security_group",
};

/** A quota row before identity/timestamps are attached — the pure normalizer output (testable). */
export interface NormalizedQuota {
	region: string;
	quota_kind: CapabilityQuotaKind;
	native_id: string;
	name: string;
	quota_limit: number | null;
	used: number | null;
	available: number | null;
}

interface AzureLocation {
	name?: string;
	metadata?: { regionType?: string };
}
interface AzureUsage {
	name?: { value?: string; localizedValue?: string };
	currentValue?: number;
	limit?: number;
}

/** Maps a location's Microsoft.Network usages to headroom rows for the networking kinds we track.
 * `available` = limit − currentValue where both are known. Pure — no IO. */
export function normalizeAzureNetworkUsages(
	region: string,
	usages: AzureUsage[],
): NormalizedQuota[] {
	const out: NormalizedQuota[] = [];
	for (const u of usages) {
		const key = u.name?.value;
		if (!key) continue;
		const kind = AZURE_USAGE_KINDS[key];
		if (!kind) continue;
		const limit = typeof u.limit === "number" ? u.limit : null;
		const used = typeof u.currentValue === "number" ? u.currentValue : null;
		out.push({
			region,
			quota_kind: kind,
			native_id: key,
			name: u.name?.localizedValue ?? key,
			quota_limit: limit,
			used,
			available: limit !== null && used !== null ? limit - used : null,
		});
	}
	return out;
}

/** Acquires an ARM bearer token as the customer managed identity (keyless), or throws. */
async function azureToken(tenantId: string, clientId: string): Promise<string> {
	const cred = assumeAzureIdentity(tenantId, clientId);
	const t = await cred.getToken("https://management.azure.com/.default");
	if (!t?.token) throw new Error("Azure token acquisition returned no token");
	return t.token;
}

/** A single ARM GET with an abort timeout; throws on a non-2xx. */
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

/** Follows ARM `nextLink` pagination, accumulating the `value[]` pages. */
async function armListValue<T>(firstUrl: string, token: string): Promise<T[]> {
	const out: T[] = [];
	let url: string | undefined = firstUrl;
	for (let i = 0; i < MAX_PAGES && url; i++) {
		const page: { value?: T[]; nextLink?: string } = await armGet(url, token);
		out.push(...(page.value ?? []));
		url = page.nextLink;
	}
	return out;
}

/** Enumerates this subscription's networking usage headroom per location into `cloud_capability_quotas`.
 * Best-effort — never throws; each location call is isolated. */
export async function syncAzureQuotaCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const subscriptionId = identity.credentials.subscription_id;
	const tenantId = identity.credentials.tenant_id;
	const clientId = identity.credentials.client_id;
	if (!subscriptionId || !tenantId || !clientId) return;

	let token: string;
	try {
		token = await azureToken(tenantId, clientId);
	} catch {
		return;
	}
	const db = getServiceDb();
	const identityId = identity.id;

	let regionNames: string[] = [];
	try {
		const locations = await armListValue<AzureLocation>(
			`${ARM}/subscriptions/${subscriptionId}/locations?api-version=${API_LOCATIONS}`,
			token,
		);
		regionNames = locations
			.filter((l) => l.metadata?.regionType !== "Logical")
			.map((l) => l.name)
			.filter((n): n is string => Boolean(n));
	} catch {
		return;
	}
	if (regionNames.length === 0) return;

	const now = new Date();
	const seen: string[] = [];

	for (const region of regionNames) {
		let usages: AzureUsage[] = [];
		try {
			usages = await armListValue<AzureUsage>(
				`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Network/locations/${region}/usages?api-version=${API_NETWORK_USAGES}`,
				token,
			);
		} catch {
			continue;
		}

		const rows = normalizeAzureNetworkUsages(region, usages);
		if (rows.length === 0) continue;

		const insertRows = rows.map((r) => {
			seen.push(r.native_id);
			return {
				cloud_identity_id: identityId,
				provider: "azure" as const,
				region: r.region,
				native_id: r.native_id,
				name: r.name,
				quota_kind: r.quota_kind,
				quota_limit: r.quota_limit,
				used: r.used,
				available: r.available,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			};
		});

		await db
			.insert(cloudCapabilityQuotas)
			.values(insertRows)
			.onConflictDoUpdate({
				target: [
					cloudCapabilityQuotas.cloud_identity_id,
					cloudCapabilityQuotas.provider,
					cloudCapabilityQuotas.region,
					cloudCapabilityQuotas.quota_kind,
					cloudCapabilityQuotas.native_id,
				],
				set: {
					name: sql`excluded.name`,
					quota_limit: sql`excluded.quota_limit`,
					used: sql`excluded.used`,
					available: sql`excluded.available`,
					last_seen: sql`excluded.last_seen`,
					last_synced_at: sql`excluded.last_synced_at`,
					removed_at: sql`excluded.removed_at`,
				},
			});
	}

	await softRemoveUnseen("cloud_capability_quotas", identityId, seen);
}
