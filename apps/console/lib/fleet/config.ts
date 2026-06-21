// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cloudProvider } from "@/lib/db/schema";
import type { Pool } from "@/lib/fleet/provider";
import { z } from "zod";

// Pools are configured via FLEET_POOLS (a JSON array). Cloud-specific addressing
// (ECS cluster/service, hcloud server type) belongs to the provider impl, not here.
const poolSchema = z.object({
	provider: z.enum(cloudProvider.enumValues),
	warmMin: z.number().int().min(0).default(0),
	max: z.number().int().min(0).default(10),
	slotsPerRunner: z.number().int().min(1).default(1),
	scaleDownGraceTicks: z.number().int().min(1).default(5),
});
const poolsSchema = z.array(poolSchema);

/** Parse FLEET_POOLS. Default (unset/invalid) → [] → the scaler is a no-op. */
export function getFleetPools(): Pool[] {
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
	return parsed.data;
}
