// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Token-cloud inventory (DigitalOcean / Hetzner / Civo). The useful inventory on these clouds is
// their REGIONS (for placement); decrypt the token, list regions, upsert into cloud_regions.
//
// Hetzner is the exception, and #1816 is why. It DOES have customer networks — `hcloud_network`,
// the same private network an Alethia cluster attaches to — and the canvas's "Existing network"
// control is a SELECT over synced inventory, not a free-text box. Listing regions only meant that
// picker was permanently empty, so `provision_network = false` could not be chosen at all even
// after the template learned to honor it. Networks are synced here for that reason.

import { asRecord, toRecordArray } from "@/lib/records";
import { decryptSecret } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { type CloudIdentity, cloudNetworks, cloudRegions } from "@/lib/db/schema";
import { sealSensitive, softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 12_000;
const HCLOUD_PER_PAGE = 50;
const HCLOUD_MAX_PAGES = 200;

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

/** One hcloud network, as much of it as the picker and the template need. */
interface HcloudNetwork {
	/** The numeric hcloud id AS A STRING: `native_id` is a text column, and the template's
	 *  `local.existing_network_is_id` decides id-vs-name by whether the value parses as a number. */
	nativeId: string;
	name: string | null;
	ipRange?: string;
}

/**
 * Narrows one entry of `/v1/networks` into the fields we store, or null if it is not usable.
 *
 * Narrowed field by field rather than asserted: this is an external API response, so the shape is a
 * claim about someone else's server rather than a fact about this codebase, and a bad `id` should
 * drop one row instead of writing `"undefined"` into a native_id the template later looks up.
 */
function readHcloudNetwork(raw: Record<string, unknown>): HcloudNetwork | null {
	if (typeof raw.id !== "number") return null;
	return {
		nativeId: String(raw.id),
		name: typeof raw.name === "string" ? raw.name : null,
		ipRange: typeof raw.ip_range === "string" ? raw.ip_range : undefined,
	};
}

/** GETs a token cloud's JSON with the shared bearer auth and timeout. */
async function tokenCloudGet(url: string, token: string): Promise<unknown> {
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
 * Paginates hcloud's `/v1/networks`, accumulating `networks` across pages (bounded by
 * HCLOUD_MAX_PAGES, strict forward progress via `meta.pagination.next_page`).
 *
 * This cannot be a single unpaginated call like the regions path: hcloud returns 25 per page by
 * default (50 max), and `syncHetznerNetworks` feeds the full listing into `softRemoveUnseen` — so
 * an unseen page is not merely a short picker, it actively soft-removes every network past page 1
 * on each sync (#1979). Lifted from #1912's `hcloudList` rather than re-derived.
 */
async function listHetznerNetworks(token: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let page = 1;
	for (let i = 0; i < HCLOUD_MAX_PAGES; i++) {
		const body = asRecord(
			await tokenCloudGet(
				`https://api.hetzner.cloud/v1/networks?per_page=${HCLOUD_PER_PAGE}&page=${page}`,
				token,
			),
		);
		out.push(...toRecordArray(body.networks));
		const next = asRecord(asRecord(body.meta).pagination).next_page;
		if (typeof next !== "number" || next <= page) break;
		page = next;
	}
	return out;
}

/**
 * Syncs Hetzner's private networks into cloud_networks, so the canvas's "Existing network" picker
 * has something to show. Mirrors the VPC loop in inventory/aws.ts, including sealing the CIDR into
 * the encrypted `sensitive` column rather than storing it in the clear.
 *
 * `region` is null: an hcloud network spans network zones rather than living in one location, and
 * claiming a region here would filter it out of the picker for every other region.
 */
async function syncHetznerNetworks(identityId: string, token: string): Promise<void> {
	const networks = await listHetznerNetworks(token);

	const db = getServiceDb();
	const seen: string[] = [];
	for (const raw of networks) {
		const net = readHcloudNetwork(raw);
		if (!net) continue;
		const nativeId = net.nativeId;
		seen.push(nativeId);
		const name = net.name;
		const sensitive = sealSensitive({ cidr_block: net.ipRange });
		const now = new Date();
		await db
			.insert(cloudNetworks)
			.values({
				cloud_identity_id: identityId,
				provider: "hetzner",
				region: null,
				native_id: nativeId,
				name,
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
					name,
					sensitive,
					last_seen: now,
					last_synced_at: now,
					removed_at: null,
				},
			});
	}
	await softRemoveUnseen("cloud_networks", identityId, seen);
}

/** Syncs a token cloud's regions into cloud_regions, and Hetzner's networks into cloud_networks. */
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

	const regionNames = spec.pick(await tokenCloudGet(spec.url, token));

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

	// Networks are Hetzner-only: DigitalOcean and Civo expose no equivalent the canvas can offer,
	// and an empty sweep here would soft-remove nothing rather than nothing at all.
	if (identity.provider === "hetzner") {
		await syncHetznerNetworks(identity.id, token);
	}
}
