// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads an environment's tofu state and extracts the native ids it tracks. A resource in state is NOT
// an orphan — tofu knows about it, and a normal `destroy` will clean it up.
//
// Note the deliberate asymmetry: every mistake here must fail toward KEEPING a resource. So we
// over-collect id-like attributes rather than trying to know each provider's exact id field. A native
// id we wrongly believe is in state means one orphan survives (it bills, and an operator finds it). A
// native id we MISS means we delete a resource tofu is actively managing. Those are not comparable, so
// the code is generous on purpose.

import { asRecord } from "@/lib/records";
import { storage } from "@/lib/storage";
import { TOFU_STATE_BUCKET } from "@/lib/storage/tofu-state";

/** Attribute names that carry a provider-native handle across our five clouds. */
const ID_ATTRS = [
	"id",
	"arn",
	"self_link",
	"resource_id",
	"instance_id",
	"volume_id",
	"network_id",
	"subnet_id",
	"cluster_id",
];

/**
 * Every native id tracked by the state object at `stateKey`. An ABSENT state file yields an empty set,
 * which is correct and is exactly the incident's shape: the apply was fenced before its first write,
 * so the resources it had already created appear in no state at all.
 *
 * Throws if the state exists but cannot be parsed — an unreadable state must never be read as "tracks
 * nothing", which would make every resource in the cloud look like an orphan.
 */
export async function stateNativeIds(
	stateKey: string,
): Promise<ReadonlySet<string>> {
	const raw = await storage.get(TOFU_STATE_BUCKET, stateKey);
	if (!raw) return new Set();

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(raw));
	} catch (err) {
		throw new Error(
			`orphan reclaim: tofu state at ${stateKey} is unreadable — refusing to treat it as empty (${String(err)})`,
		);
	}

	const ids = new Set<string>();
	const resources = (parsed as { resources?: unknown })?.resources;
	if (!Array.isArray(resources)) return ids;

	for (const resource of resources) {
		const instances = (resource as { instances?: unknown })?.instances;
		if (!Array.isArray(instances)) continue;
		for (const instance of instances) {
			const attrs = (instance as { attributes?: unknown })?.attributes;
			if (!attrs || typeof attrs !== "object") continue;
			for (const attr of ID_ATTRS) {
				const value = asRecord(attrs)[attr];
				// Providers type ids as string or number (hcloud uses numeric ids). Normalize both.
				if (typeof value === "string" && value) ids.add(value);
				else if (typeof value === "number") ids.add(String(value));
			}
		}
	}
	return ids;
}
