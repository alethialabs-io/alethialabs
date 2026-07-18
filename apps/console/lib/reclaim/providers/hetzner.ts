// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner orphan-reclaim adapter.
//
// This is the cloud the orphan incident actually happened on, and the one where the stakes are
// sharpest: the hcloud account that runs test clusters is the SAME account that runs prod. So every
// list here goes through hcloud's native `label_selector` query parameter — a genuine SERVER-SIDE
// filter. We never list the account and filter afterwards; a client-side filter is one bad predicate
// away from enumerating prod.
//
// The adapter lists and deletes. It decides nothing — see lib/reclaim/guards.ts.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { asRecord } from "@/lib/records";
import { cloudIdentities } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { CloudResourceRef, LabelSelector, ReclaimAdapter } from "../types";

const API = "https://api.hetzner.cloud/v1";
const TIMEOUT_MS = 15_000;

/** The hcloud collections our project template creates, and the JSON key each list response uses. */
const COLLECTIONS = [
	{ kind: "server", path: "servers", key: "servers" },
	{ kind: "load_balancer", path: "load_balancers", key: "load_balancers" },
	{ kind: "volume", path: "volumes", key: "volumes" },
	{ kind: "primary_ip", path: "primary_ips", key: "primary_ips" },
	{ kind: "firewall", path: "firewalls", key: "firewalls" },
	{ kind: "network", path: "networks", key: "networks" },
	{
		kind: "placement_group",
		path: "placement_groups",
		key: "placement_groups",
	},
	{ kind: "ssh_key", path: "ssh_keys", key: "ssh_keys" },
] as const;

/** One entry of an hcloud list response — every collection shares this shape. */
/** One hcloud resource as its collection endpoints return it — validated (not asserted) so a
 *  shape change degrades to an empty page rather than a bad read. */
const hcloudItemSchema = z.object({
	id: z.number(),
	name: z.string().nullish(),
	created: z.string().nullish(),
	labels: z.record(z.string(), z.string()).nullish(),
	location: z.object({ name: z.string().optional() }).nullish(),
	datacenter: z
		.object({ location: z.object({ name: z.string().optional() }).nullish() })
		.nullish(),
});

/** Resolves the account's API token from the stored (encrypted) cloud identity. */
async function tokenFor(identityId: string): Promise<string> {
	const [identity] = await getServiceDb()
		.select({ credentials: cloudIdentities.credentials })
		.from(cloudIdentities)
		.where(eq(cloudIdentities.id, identityId))
		.limit(1);

	const enc = identity?.credentials?.token;
	if (!enc) throw new Error("hetzner reclaim: cloud identity has no API token");
	const decoded = decryptSecret(enc);
	const token =
		decoded.api_token ?? decoded.token ?? Object.values(decoded)[0] ?? "";
	if (!token) throw new Error("hetzner reclaim: empty API token");
	return token;
}

/** A single hcloud API call with a timeout. Returns the parsed body, or null on 404. */
async function call(
	token: string,
	path: string,
	init?: RequestInit,
): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${API}/${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		// Idempotence: a resource that is already gone is a successful delete, not an error.
		if (res.status === 404) return null;
		if (!res.ok) {
			throw new Error(`hcloud ${init?.method ?? "GET"} ${path}: HTTP ${res.status}`);
		}
		if (res.status === 204) return null;
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** Reads one collection, filtered SERVER-SIDE by the label selector, following pagination. */
async function listCollection(
	token: string,
	path: string,
	key: string,
	kind: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const out: CloudResourceRef[] = [];
	// `label_selector` is hcloud's own filter. It is the ONLY thing standing between this sweep and
	// every other cluster in the account, including prod — so it is always sent, never optional.
	const query = `label_selector=${encodeURIComponent(`${selector.key}=${selector.value}`)}`;

	for (let page = 1; ; page++) {
		const body = await call(token, `${path}?${query}&page=${page}&per_page=50`);
		const items = z.array(hcloudItemSchema).catch([]).parse(asRecord(body)[key]);
		if (items.length === 0) break;

		for (const item of items) {
			out.push({
				native_id: String(item.id),
				kind,
				name: item.name ?? null,
				region: item.location?.name ?? item.datacenter?.location?.name ?? null,
				// hcloud stamps `created` on every resource, so the created-after guard is always
				// evaluable here — no Hetzner resource gets refused for an unknown age.
				created_at: item.created ? new Date(item.created) : null,
				labels: item.labels ?? {},
			});
		}
		if (items.length < 50) break;
	}
	return out;
}

/**
 * Lists every hcloud resource carrying the selector label, across the collections our template
 * creates. Server-side filtered throughout.
 */
async function list(
	identityId: string,
	selector: LabelSelector,
): Promise<CloudResourceRef[]> {
	const token = await tokenFor(identityId);
	const results = await Promise.all(
		COLLECTIONS.map((c) =>
			listCollection(token, c.path, c.key, c.kind, selector),
		),
	);
	return results.flat();
}

/** Deletes one hcloud resource by native id. Idempotent: an already-deleted resource is a success. */
async function remove(
	identityId: string,
	resource: CloudResourceRef,
): Promise<void> {
	const token = await tokenFor(identityId);
	const collection = COLLECTIONS.find((c) => c.kind === resource.kind);
	if (!collection) {
		throw new Error(`hetzner reclaim: unknown kind ${resource.kind}`);
	}
	// A volume still attached to a server refuses deletion. Servers are deleted first (see
	// deleteOrder), which detaches them — so by the time we reach a volume it is free. If a detach is
	// still pending, the 409 surfaces and the sweep retries on its next tick rather than forcing.
	await call(token, `${collection.path}/${resource.native_id}`, {
		method: "DELETE",
	});
}

export const hetznerReclaim: ReclaimAdapter = {
	provider: "hetzner",
	list,
	delete: remove,
	// Most-dependent first. Servers go before the volumes attached to them, the load balancers in
	// front of them, and the network they all sit in — otherwise the deletes simply fail.
	deleteOrder: [
		"server",
		"load_balancer",
		"volume",
		"primary_ip",
		"firewall",
		"placement_group",
		"network",
		"ssh_key",
	],
};
