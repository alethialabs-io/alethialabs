// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Token-cloud inventory (DigitalOcean / Hetzner / Civo) — these clouds don't have customer VPCs the
// way the hyperscalers do; the useful inventory is their REGIONS (for placement). Decrypt the token,
// list regions, upsert into cloud_regions. Works locally (HTTP + stored token).

import { asRecord, toRecordArray } from "@/lib/records";
import { decryptSecret } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { type CloudIdentity, cloudRegions } from "@/lib/db/schema";
import { softRemoveUnseen } from "./upsert";

const TIMEOUT_MS = 12_000;

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

/** Syncs a token cloud's regions into cloud_regions. */
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

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let regionNames: string[];
	try {
		const res = await fetch(spec.url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		regionNames = spec.pick(await res.json());
	} finally {
		clearTimeout(timer);
	}

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
}
