// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DB-backed pool config (dataroom/spec/mvp/26). The Fleet Controller reads enabled `fleet_pools`
// rows every tick, so edits made in the console go live without a redeploy. `FLEET_POOLS`
// (env) is deprecated — kept only as a one-time seed for existing deployments.

import { getServiceDb } from "@/lib/db";
import { fleetPools, type FleetPool, type NewFleetPool } from "@/lib/db/schema";
import { getFleetPools } from "@/lib/fleet/config";
import { managedRunnersByInstance } from "@/lib/fleet/queue";
import type { FleetProvider, FleetTarget } from "@/lib/fleet/types";
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

/** Load EVERY pool as a controller project — including paused (`enabled = false`) and
 *  soft-deleted (`deleting = true`) rows, so the controller can drain their VMs to zero and close
 *  the runners' usage sessions instead of orphaning them. A disabled OR deleting row maps to a
 *  TEARDOWN target (target → 0, destroy every instance, never create); a normal enabled row maps
 *  1:1 as before. (Previously this filtered to `enabled = true`, so a deleted/paused pool vanished
 *  from the controller and its VMs + sessions leaked forever.) */
export async function loadFleetPools(): Promise<FleetTarget[]> {
	const rows = await getServiceDb().select().from(fleetPools);
	return rows.map((row) => {
		const target = rowToProject(row);
		return !row.enabled || row.deleting ? { ...target, teardown: true } : target;
	});
}

/** Physically remove soft-deleted (`deleting = true`) pools once fully torn down: their VMs are
 *  all gone (provider.list empty) AND no ONLINE/DRAINING managed runner still maps to the provider
 *  (an online/draining runner still holds an open metered session; guards the list-race where a VM
 *  is destroyed but its runner hasn't been observed/retired yet). We must NOT gate on ALL runner
 *  rows: a retired VM leaves an OFFLINE runner row whose session is already closed (by
 *  sweep_offline_runners), and nothing GCs those rows — gating on them would keep the tombstone row
 *  forever, list()-ing it every tick. Once the runner is OFFLINE its session is closed, so it no
 *  longer blocks reaping. Called after each reconcile pass; a still-draining pool waits for a later
 *  tick. Idempotent (delete targets the specific row id). */
export async function reapDeletedPools(provider: FleetProvider): Promise<void> {
	const rows = await getServiceDb()
		.select()
		.from(fleetPools)
		.where(eq(fleetPools.deleting, true));
	for (const row of rows) {
		const instances = await provider.list(rowToProject(row));
		if (instances.length > 0) continue; // VMs still draining/destroying
		const runners = await managedRunnersByInstance(row.provider);
		// Only ONLINE/DRAINING runners still bill (open session); OFFLINE = already retired + closed.
		const stillLive = [...runners.values()].some((r) => r.status !== "offline");
		if (stillLive) continue; // a runner hasn't retired/closed its session yet — wait
		await getServiceDb().delete(fleetPools).where(eq(fleetPools.id, row.id));
		flog.info("removed torn-down pool", { pool_id: row.id, provider: row.provider });
	}
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
