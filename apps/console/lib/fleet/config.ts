// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cloudProvider } from "@/lib/db/schema";
import type { FleetTarget } from "@/lib/fleet/types";
import { z } from "zod";

// Declarative pool projects via FLEET_POOLS (a JSON array). Cloud-specific addressing
// (hcloud server type, image) belongs to the provider impl, not here. Default [] = the
// controller is a no-op. `version` pins an exact image; `channel` (e.g. "stable") is
// resolved to the newest runner_releases by the controller each tick.
export const poolSchema = z.object({
	provider: z.enum(cloudProvider.enumValues),
	warmMin: z.number().int().min(0).default(1),
	max: z.number().int().min(0).default(10),
	slotsPerRunner: z.number().int().min(1).default(1),
	locations: z.array(z.string().min(1)).min(1).default(["fsn1"]),
	minPerLocation: z.number().int().min(0).default(0),
	surge: z.number().int().min(1).default(1),
	buffer: z.number().int().min(0).default(1),
	scaleDownGraceTicks: z.number().int().min(1).default(5),
	version: z.string().min(1).optional(),
	channel: z.string().min(1).optional(),
});
const poolsSchema = z.array(poolSchema);

/** Parse FLEET_POOLS into projects. Default (unset/invalid) → [] → the controller is a no-op. */
export function getFleetPools(): FleetTarget[] {
	const raw = process.env.FLEET_POOLS;
	if (!raw) return [];
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		console.error("[fleet] FLEET_POOLS is not valid JSON; ignoring:", err);
		return [];
	}
	const parsed = poolsSchema.safeParse(json);
	if (!parsed.success) {
		console.error("[fleet] invalid FLEET_POOLS:", parsed.error.message);
		return [];
	}
	return parsed.data.map((p) => ({
		provider: p.provider,
		warmMin: p.warmMin,
		max: p.max,
		slotsPerRunner: p.slotsPerRunner,
		locations: p.locations,
		minPerLocation: p.minPerLocation,
		surge: p.surge,
		buffer: p.buffer,
		scaleDownGraceTicks: p.scaleDownGraceTicks,
		// A pinned version wins; otherwise the controller resolves `channel` → latest.
		targetVersion: p.version ?? null,
		channel: p.version ? null : (p.channel ?? null),
	}));
}
