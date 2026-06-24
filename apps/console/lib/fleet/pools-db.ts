// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DB-backed pool config (dataroom/spec/mvp/26). The Fleet Controller reads enabled `fleet_pools`
// rows every tick, so edits made in the console go live without a redeploy. `FLEET_POOLS`
// (env) is deprecated — kept only as a one-time seed for existing deployments.

import { getServiceDb } from "@/lib/db";
import { fleetPools, type FleetPool, type NewFleetPool } from "@/lib/db/schema";
import { getFleetPools } from "@/lib/fleet/config";
import type { FleetSpec } from "@/lib/fleet/types";
import { eq } from "drizzle-orm";

/** Map a stored pool row to the controller's FleetSpec (a pinned `version` wins; else the
 *  controller resolves `channel` → latest release). */
export function rowToSpec(row: FleetPool): FleetSpec {
	return {
		provider: row.provider,
		warmMin: row.warm_min,
		max: row.max,
		slotsPerRunner: row.slots_per_runner,
		locations: row.locations,
		minPerLocation: row.min_per_location,
		surge: row.surge,
		buffer: row.buffer,
		scaleDownGraceTicks: row.scale_down_grace_ticks,
		targetVersion: row.version ?? null,
		channel: row.version ? null : (row.channel ?? null),
	};
}

/** Load the enabled pools as controller specs. Disabled (paused) pools are skipped. */
export async function loadFleetPools(): Promise<FleetSpec[]> {
	const rows = await getServiceDb()
		.select()
		.from(fleetPools)
		.where(eq(fleetPools.enabled, true));
	return rows.map(rowToSpec);
}

/** Map a FleetSpec back to an insert row (for the env → DB seed). */
function specToRow(spec: FleetSpec): NewFleetPool {
	return {
		provider: spec.provider,
		warm_min: spec.warmMin,
		max: spec.max,
		slots_per_runner: spec.slotsPerRunner,
		locations: spec.locations,
		min_per_location: spec.minPerLocation,
		surge: spec.surge,
		buffer: spec.buffer,
		scale_down_grace_ticks: spec.scaleDownGraceTicks,
		version: spec.targetVersion,
		channel: spec.channel,
	};
}

/** One-time migration aid: if `fleet_pools` is empty and `FLEET_POOLS` is set, import the
 *  env specs so existing deployments don't lose their config. Idempotent (no-op once rows
 *  exist; conflicts on the unique provider are ignored). After this the DB is the source
 *  of truth and the env var is ignored. */
export async function seedFleetPoolsFromEnv(): Promise<void> {
	const envPools = getFleetPools();
	if (envPools.length === 0) return;
	const db = getServiceDb();
	const existing = await db.select({ id: fleetPools.id }).from(fleetPools).limit(1);
	if (existing.length > 0) return;
	await db
		.insert(fleetPools)
		.values(envPools.map(specToRow))
		.onConflictDoNothing({ target: fleetPools.provider });
	console.log(`[fleet] seeded ${envPools.length} pool(s) from FLEET_POOLS env`);
}
