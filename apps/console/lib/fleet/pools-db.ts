// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DB-backed pool config (dataroom/spec/mvp/26). The Fleet Controller reads enabled `fleet_pools`
// rows every tick, so edits made in the console go live without a redeploy. `FLEET_POOLS`
// (env) is deprecated — kept only as a one-time seed for existing deployments.

import { getServiceDb } from "@/lib/db";
import { fleetPools, type FleetPool, type NewFleetPool } from "@/lib/db/schema";
import { getFleetPools } from "@/lib/fleet/config";
import type { FleetTarget } from "@/lib/fleet/types";
import { log } from "@/lib/observability/log";
import { eq } from "drizzle-orm";

const flog = log.child({ component: "fleet" });

/** Map a stored pool row to the controller's FleetTarget (a pinned `version` wins; else the
 *  controller resolves `channel` → latest release). */
export function rowToProject(row: FleetPool): FleetTarget {
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

/** Load the enabled pools as controller projects. Disabled (paused) pools are skipped. */
export async function loadFleetPools(): Promise<FleetTarget[]> {
	const rows = await getServiceDb()
		.select()
		.from(fleetPools)
		.where(eq(fleetPools.enabled, true));
	return rows.map(rowToProject);
}

/** Map a FleetTarget back to an insert row (for the env → DB seed). */
function projectToRow(project: FleetTarget): NewFleetPool {
	return {
		provider: project.provider,
		warm_min: project.warmMin,
		max: project.max,
		slots_per_runner: project.slotsPerRunner,
		locations: project.locations,
		min_per_location: project.minPerLocation,
		surge: project.surge,
		buffer: project.buffer,
		scale_down_grace_ticks: project.scaleDownGraceTicks,
		version: project.targetVersion,
		channel: project.channel,
	};
}

/** One-time migration aid: if `fleet_pools` is empty and `FLEET_POOLS` is set, import the
 *  env projects so existing deployments don't lose their config. Idempotent (no-op once rows
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
		.values(envPools.map(projectToRow))
		.onConflictDoNothing({ target: fleetPools.provider });
	flog.info("seeded pools from FLEET_POOLS env", { pool_count: envPools.length });
}
