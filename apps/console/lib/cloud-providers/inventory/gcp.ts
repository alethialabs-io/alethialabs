// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GCP inventory — networks + subnetworks via the Compute REST API using a WIF-minted token. Upserts
// into the shared typed tables (same path as AWS). Verifiable in a hosted env with the WIF subject-token
// source; a no-op (clean throw → caught by the dispatcher) without it.

import { ExternalAccountClient } from "google-auth-library";
import { getServiceDb } from "@/lib/db";
import {
	type CloudIdentity,
	cloudNetworks,
	cloudSubnets,
} from "@/lib/db/schema";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 15_000;

/** Mints a GCP access token from the connection's stored WIF config, or throws. */
async function gcpToken(identity: Pick<CloudIdentity, "credentials">): Promise<string> {
	const wif = identity.credentials.wif_config;
	if (!wif) throw new Error("No GCP WIF config");
	const client = ExternalAccountClient.fromJSON(
		wif as unknown as Parameters<typeof ExternalAccountClient.fromJSON>[0],
	);
	if (!client) throw new Error("Invalid GCP WIF config");
	const at = await client.getAccessToken();
	if (!at.token) throw new Error("GCP token acquisition returned no token");
	return at.token;
}

interface GcpNetwork {
	id?: string;
	name?: string;
	selfLink?: string;
	autoCreateSubnetworks?: boolean;
}
interface GcpSubnet {
	id?: string;
	name?: string;
	ipCidrRange?: string;
	region?: string;
	network?: string;
	privateIpGoogleAccess?: boolean;
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
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/** Syncs one GCP identity's networks + subnetworks into the typed tables. */
export async function syncGcpInventory(
	identity: Pick<CloudIdentity, "id" | "credentials">,
): Promise<void> {
	const projectId = identity.credentials.project_id;
	if (!projectId) throw new Error("No GCP project id");
	const token = await gcpToken(identity);
	const db = getServiceDb();
	const identityId = identity.id;

	const networks = await gcpGet<{ items?: GcpNetwork[] }>(
		`https://compute.googleapis.com/compute/v1/projects/${projectId}/networks`,
		token,
	);
	const seenNets: string[] = [];
	const netRowId = new Map<string, string>();
	for (const net of networks.items ?? []) {
		const native = net.selfLink ?? net.name;
		if (!native) continue;
		seenNets.push(native);
		const now = new Date();
		const [row] = await db
			.insert(cloudNetworks)
			.values({
				cloud_identity_id: identityId,
				provider: "gcp",
				region: null,
				native_id: native,
				name: net.name ?? null,
				is_default: net.autoCreateSubnetworks ?? false,
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
					name: net.name ?? null,
					is_default: net.autoCreateSubnetworks ?? false,
					last_seen: now,
					last_synced_at: now,
					removed_at: null,
				},
			})
			.returning({ id: cloudNetworks.id });
		if (row && net.selfLink) netRowId.set(net.selfLink, row.id);
	}
	await softRemoveUnseen("cloud_networks", identityId, seenNets);

	// Subnetworks (aggregated across regions).
	const subs = await gcpGet<{
		items?: Record<string, { subnetworks?: GcpSubnet[] }>;
	}>(
		`https://compute.googleapis.com/compute/v1/projects/${projectId}/aggregated/subnetworks`,
		token,
	);
	const seenSubs: string[] = [];
	for (const scope of Object.values(subs.items ?? {})) {
		for (const sn of scope.subnetworks ?? []) {
			const native = sn.id ?? sn.name;
			if (!native) continue;
			seenSubs.push(native);
			const now = new Date();
			await db
				.insert(cloudSubnets)
				.values({
					cloud_identity_id: identityId,
					provider: "gcp",
					region: sn.region ? sn.region.split("/").pop() ?? null : null,
					native_id: native,
					name: sn.name ?? null,
					network_id: sn.network ? (netRowId.get(sn.network) ?? null) : null,
					sensitive: sealSensitive({ cidr_block: sn.ipCidrRange ?? undefined }),
					is_public: !(sn.privateIpGoogleAccess ?? false),
						last_seen: now,
					last_synced_at: now,
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
						network_id: sn.network ? (netRowId.get(sn.network) ?? null) : null,
						sensitive: sealSensitive({ cidr_block: sn.ipCidrRange ?? undefined }),
						last_seen: now,
						last_synced_at: now,
						removed_at: null,
					},
				});
		}
	}
	await softRemoveUnseen("cloud_subnets", identityId, seenSubs);
}
