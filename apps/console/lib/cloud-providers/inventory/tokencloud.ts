// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Token-cloud inventory (DigitalOcean / Hetzner / Civo). The always-useful inventory is their REGIONS
// (for placement); Hetzner additionally exposes project NETWORKS, which the canvas "Existing network"
// picker reads so bring-your-own-network is reachable (#1896). Decrypt the token, list, upsert into
// cloud_regions / cloud_networks. Works locally (HTTP + stored token).

import { asRecord, toRecordArray } from "@/lib/records";
import { decryptSecret } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { type CloudIdentity, cloudNetworks, cloudRegions } from "@/lib/db/schema";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 12_000;
const HCLOUD_API = "https://api.hetzner.cloud/v1";
const PER_PAGE = 50;
const MAX_PAGES = 200;

/** (endpoint, json→region-slugs) per token cloud. */
const REGIONS: Record<
	string,
	{ url: string; pick: (json: unknown) => string[] }
> = {
	digitalocean: {
		url: "https://api.digitalocean.com/v2/regions",
		pick: (j) =>
			toRecordArray(asRecord(j).regions)
				.map((r) => r.slug)
				.filter((s): s is string => Boolean(s)),
	},
	civo: {
		url: "https://api.civo.com/v2/regions",
		pick: (j) =>
			toRecordArray(j)
				.map((r) => r.code)
				.filter((s): s is string => Boolean(s)),
	},
	hetzner: {
		url: "https://api.hetzner.cloud/v1/locations",
		pick: (j) =>
			toRecordArray(asRecord(j).locations)
				.map((r) => r.name)
				.filter((s): s is string => Boolean(s)),
	},
};

/** One discovered network, normalized out of whatever shape the cloud's list endpoint returns. */
interface TokenCloudNetwork {
	/** The provider-native, stable handle stored in `cloud_networks.native_id`. */
	nativeId: string;
	name: string | null;
	/** Reconnaissance-sensitive — sealed into the `sensitive` column, never stored in plaintext. */
	cidrBlock: string | null;
}

/** GETs a JSON body with a bearer token under a hard timeout. Throws on a non-2xx. */
async function getJson(url: string, token: string): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Paginates a hcloud list endpoint, accumulating `body[key]` across pages (bounded by MAX_PAGES,
 * strict forward progress). Unlike the regions path this cannot be a single unpaginated call: hcloud
 * caps a page at 50, so a project with more networks than that would silently lose the rest.
 */
async function hcloudListAll(
	resource: string,
	key: string,
	token: string,
): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let page = 1;
	for (let i = 0; i < MAX_PAGES; i++) {
		const body = asRecord(
			await getJson(`${HCLOUD_API}/${resource}?per_page=${PER_PAGE}&page=${page}`, token),
		);
		out.push(...toRecordArray(body[key]));
		const next = asRecord(asRecord(body.meta).pagination).next_page;
		if (typeof next !== "number" || next <= page) break;
		page = next;
	}
	return out;
}

/**
 * Per-token-cloud network listing. Only Hetzner is wired: DigitalOcean (VPCs) and Civo (networks)
 * sit on this exact path and have the same gap, but #1896 scopes them out deliberately — this is a
 * map, so adding one later is an entry, not a rewrite.
 */
const NETWORKS: Record<
	string,
	{ list: (token: string) => Promise<TokenCloudNetwork[]> }
> = {
	hetzner: {
		list: async (token) =>
			(await hcloudListAll("networks", "networks", token)).flatMap((n) => {
				// The numeric hcloud id is the stable handle and matches what `native_id` carries on every
				// other cloud. The template resolves either the id or the name (`network.tf`), so storing
				// the id costs nothing and survives a rename.
				const id = n.id;
				if (typeof id !== "number") return [];
				return [
					{
						nativeId: String(id),
						name: typeof n.name === "string" ? n.name : null,
						cidrBlock: typeof n.ip_range === "string" ? n.ip_range : null,
					},
				];
			}),
	},
};

/** Upserts one token cloud's networks into cloud_networks, then soft-removes the ones it didn't see. */
async function syncTokenCloudNetworks(
	identity: Pick<CloudIdentity, "id" | "provider">,
	token: string,
): Promise<void> {
	const spec = NETWORKS[identity.provider];
	if (!spec) return;
	const networks = await spec.list(token);

	const db = getServiceDb();
	const seen: string[] = [];
	for (const net of networks) {
		seen.push(net.nativeId);
		// There is no plaintext CIDR column — the range is sealed with AES-GCM like every other cloud's.
		const sensitive = sealSensitive({ cidr_block: net.cidrBlock ?? undefined });
		const now = new Date();
		await db
			.insert(cloudNetworks)
			.values({
				cloud_identity_id: identity.id,
				provider: identity.provider,
				// hcloud networks are project-global, not regional (GCP's global networks are the
				// precedent). `existingNetworkOptions` filters on provider only, so a null region just
				// drops out of the option description.
				region: null,
				native_id: net.nativeId,
				name: net.name,
				sensitive,
				is_default: false,
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
					name: net.name,
					sensitive,
					is_default: false,
					last_seen: now,
					last_synced_at: now,
					removed_at: null,
				},
			});
	}
	await softRemoveUnseen("cloud_networks", identity.id, seen);
}

/** Syncs a token cloud's regions into cloud_regions, and its networks (Hetzner) into cloud_networks. */
export async function syncTokenCloudInventory(
	identity: Pick<CloudIdentity, "id" | "provider" | "credentials">,
): Promise<void> {
	const spec = REGIONS[identity.provider];
	if (!spec) return;
	const enc = identity.credentials.token;
	if (!enc) return;
	const decoded = decryptSecret(enc);
	const token = decoded.api_token ?? decoded.token ?? Object.values(decoded)[0] ?? "";
	if (!token) return;

	const regionNames = spec.pick(await getJson(spec.url, token));

	const db = getServiceDb();
	const seen: string[] = [];
	for (const region of regionNames) {
		seen.push(region);
		const now = new Date();
		await db
			.insert(cloudRegions)
			.values({
				cloud_identity_id: identity.id,
				provider: identity.provider,
				region,
				native_id: region,
				name: region,
				last_seen: now,
				last_synced_at: now,
				removed_at: null,
			})
			.onConflictDoUpdate({
				target: [
					cloudRegions.cloud_identity_id,
					cloudRegions.provider,
					cloudRegions.native_id,
				],
				set: { last_seen: now, last_synced_at: now, removed_at: null },
			});
	}
	await softRemoveUnseen("cloud_regions", identity.id, seen);

	// Networks are additive and run LAST, isolated: regions are the placement inventory every token
	// cloud depends on, and a networks outage (or a token without network scope) must not cost them —
	// nor the `inventory_synced_at` stamp the dispatcher writes only when this resolves. Best-effort,
	// exactly like the dispatcher above it; the reconciliation sweep retries.
	try {
		await syncTokenCloudNetworks(identity, token);
	} catch {
		// Swallowed deliberately — see above.
	}
}
