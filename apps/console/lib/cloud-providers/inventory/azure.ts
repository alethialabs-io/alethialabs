// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure inventory — virtual networks + their subnets via ARM, using the platform app token. Upserts
// into the shared typed tables. Verifiable in a hosted env with ALETHIA_AZURE_* configured.

import { ClientSecretCredential } from "@azure/identity";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	cloudNetworks,
	cloudSubnets,
} from "@/lib/db/schema";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 15_000;
const ARM = "https://management.azure.com";

/** Acquires an ARM bearer token via the platform Azure app, or throws. */
async function azureToken(): Promise<string> {
	const tenantId = process.env.ALETHIA_AZURE_TENANT_ID;
	const clientId = process.env.ALETHIA_AZURE_CLIENT_ID;
	const clientSecret = process.env.ALETHIA_AZURE_CLIENT_SECRET;
	if (!tenantId || !clientId || !clientSecret) {
		throw new Error("Platform Azure credentials are not configured");
	}
	const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
	const t = await cred.getToken("https://management.azure.com/.default");
	if (!t?.token) throw new Error("Azure token acquisition returned no token");
	return t.token;
}

interface AzureSubnet {
	id?: string;
	name?: string;
	properties?: { addressPrefix?: string };
}
interface AzureVnet {
	id?: string;
	name?: string;
	location?: string;
	properties?: { subnets?: AzureSubnet[] };
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
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/** Syncs one Azure identity's virtual networks + subnets into the typed tables. */
export async function syncAzureInventory(
	identity: Pick<CloudIdentity, "id" | "credentials">,
): Promise<void> {
	const subscriptionId = identity.credentials.subscription_id;
	if (!subscriptionId) throw new Error("No Azure subscription id");
	const token = await azureToken();
	const db = getServiceDb();
	const identityId = identity.id;

	const vnets = await armGet<{ value?: AzureVnet[] }>(
		`${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
		token,
	);

	const seenNets: string[] = [];
	const seenSubs: string[] = [];
	for (const vnet of vnets.value ?? []) {
		if (!vnet.id) continue;
		seenNets.push(vnet.id);
		const now = new Date();
		const [row] = await db
			.insert(cloudNetworks)
			.values({
				cloud_identity_id: identityId,
				provider: "azure",
				region: vnet.location ?? null,
				native_id: vnet.id,
				name: vnet.name ?? null,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			})
			.onConflictDoUpdate({
				target: [
					cloudNetworks.cloud_identity_id,
					cloudNetworks.provider,
					cloudNetworks.native_id,
				],
				set: {
					region: vnet.location ?? null,
					name: vnet.name ?? null,
					last_seen: now,
					last_synced_at: now,
					removed_at: null,
				},
			})
			.returning({ id: cloudNetworks.id });
		const networkRowId = row?.id ?? null;

		for (const sn of vnet.properties?.subnets ?? []) {
			if (!sn.id) continue;
			seenSubs.push(sn.id);
			const snNow = new Date();
			await db
				.insert(cloudSubnets)
				.values({
					cloud_identity_id: identityId,
					provider: "azure",
					region: vnet.location ?? null,
					native_id: sn.id,
					name: sn.name ?? null,
					network_id: networkRowId,
					sensitive: sealSensitive({ cidr_block: sn.properties?.addressPrefix ?? undefined }),
						last_seen: snNow,
					last_synced_at: snNow,
					removed_at: null,
				})
				.onConflictDoUpdate({
					target: [
						cloudSubnets.cloud_identity_id,
						cloudSubnets.provider,
						cloudSubnets.native_id,
					],
					set: {
						name: sn.name ?? null,
						network_id: networkRowId,
						sensitive: sealSensitive({ cidr_block: sn.properties?.addressPrefix ?? undefined }),
						last_seen: snNow,
						last_synced_at: snNow,
						removed_at: null,
					},
				});
		}
	}

	await softRemoveUnseen("cloud_networks", identityId, seenNets);
	await softRemoveUnseen("cloud_subnets", identityId, seenSubs);
}
