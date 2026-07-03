"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb } from "@/lib/db";
import { fleetPools, type CloudProvider, type FleetPool } from "@/lib/db/schema";
import {
	computeUtilizationPct,
	estimatePoolCostEur,
	fleetServerType,
	hourlyRateEur,
} from "@/lib/fleet/costs";
import {
	latestReleaseVersion,
	managedRunnerRowsForProvider,
	type ManagedRunnerRow,
} from "@/lib/fleet/queue";
import {
	jobMinutesByProvider,
	provisionedHoursByProvider,
} from "@/lib/queries/runner-usage";
import { wakeFleetScaler } from "@/lib/fleet/scaler";
import {
	fleetPoolCreateSchema,
	fleetPoolUpdateSchema,
	type FleetPoolCreateInput,
	type FleetPoolUpdateInput,
} from "@/lib/validations/fleet";
import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * The managed warm-pool fleet is platform-operator infrastructure (the `fleet_pools` rows are
 * global, with no org_id). On the hosted SaaS no tenant operates it — exposing it would leak our
 * fleet topology and COGS — so fleet reads/writes are only available on self-managed deployments,
 * where the operator IS the customer. (Enterprise / internal-admin access is a later addition.)
 */
function isFleetOperatorDeployment(): boolean {
	return deploymentMode() === "self-managed";
}

/** Throws on deployments where the managed fleet must not be reachable by the actor (hosted). */
function assertFleetOperable(): void {
	if (!isFleetOperatorDeployment()) {
		throw new Error("The managed fleet is not available on this deployment.");
	}
}

/** A version (or location) and how many live runners carry it, for a pool's distribution row. */
export interface PoolTally {
	key: string;
	count: number;
	/** Version: not the target. Location: has an offline runner (location degraded). */
	flagged: boolean;
}

/** One managed warm pool's configured target joined with observed reality — the unit the
 *  Fleet sidebar renders. Derived server-side so attribution stays in one place. */
export interface FleetPoolView {
	/** The fleet_pools row id (edit/delete/pause target). */
	id: string;
	provider: CloudProvider;
	/** Optional display label; falls back to the provider name in the UI. */
	name: string | null;
	/** False = paused: the controller skips it, but its runners still show while draining. */
	enabled: boolean;
	/** Always-warm floor (the meter's slot count). */
	target: number;
	/** Hard ceiling on instances. */
	max: number;
	/** Version every runner should converge to (pinned, or resolved from the channel). */
	targetVersion: string | null;
	/** Configured spread locations (uppercased region codes). */
	locations: string[];
	online: number;
	draining: number;
	offline: number;
	busy: number;
	/** Online runners currently running a job (the meter's hatched segments). */
	busyOnline: number;
	/** Version distribution among live (non-offline) runners, target first. */
	versions: PoolTally[];
	/** Per-location runner counts; `flagged` = the location has an offline runner. */
	locDist: PoolTally[];
	/** % of live runners already on the target version (100 when no target set). */
	rolloutPct: number;
	/** All live runners are on a single version that equals the target. */
	fullyRolled: boolean;
	/** Fewer online than the warm floor. */
	belowFloor: boolean;
	/** Below floor, or any runner offline — the pool needs attention. */
	degraded: boolean;
}

/** Build the version distribution (target first, then newest→oldest) from live runners. */
function tallyVersions(rows: ManagedRunnerRow[], targetVersion: string | null): PoolTally[] {
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (r.status === "offline") continue;
		const v = r.version ?? "unknown";
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.sort(([a], [b]) => {
			if (a === targetVersion) return -1;
			if (b === targetVersion) return 1;
			return b.localeCompare(a);
		})
		.map(([key, count]) => ({ key, count, flagged: key !== targetVersion }));
}

/** Build per-location counts; a location is flagged when any of its runners is offline. */
function tallyLocations(rows: ManagedRunnerRow[]): PoolTally[] {
	const counts = new Map<string, number>();
	const down = new Set<string>();
	for (const r of rows) {
		const loc = r.location ?? "—";
		counts.set(loc, (counts.get(loc) ?? 0) + 1);
		if (r.status === "offline") down.add(loc);
	}
	return Array.from(counts.entries()).map(([key, count]) => ({
		key,
		count,
		flagged: down.has(key),
	}));
}

/** Derive one pool view from its stored row + observed managed runners (ports poolStats). */
function toPoolView(
	pool: FleetPool,
	targetVersion: string | null,
	rows: ManagedRunnerRow[],
): FleetPoolView {
	const online = rows.filter((r) => r.status === "online").length;
	const draining = rows.filter((r) => r.status === "draining").length;
	const offline = rows.filter((r) => r.status === "offline").length;
	const busy = rows.filter((r) => r.busy).length;
	const busyOnline = rows.filter((r) => r.status === "online" && r.busy).length;

	const versions = tallyVersions(rows, targetVersion);
	const liveTotal = versions.reduce((sum, v) => sum + v.count, 0);
	const onTarget = versions.find((v) => v.key === targetVersion)?.count ?? 0;
	const rolloutPct = !targetVersion
		? 100
		: liveTotal
			? Math.round((onTarget / liveTotal) * 100)
			: 0;
	const fullyRolled =
		liveTotal > 0 && versions.length === 1 && versions[0].key === targetVersion;

	const belowFloor = online < pool.warm_min;
	const degraded = belowFloor || offline > 0;

	return {
		id: pool.id,
		provider: pool.provider,
		name: pool.name,
		enabled: pool.enabled,
		target: pool.warm_min,
		max: pool.max,
		targetVersion,
		locations: pool.locations.map((l) => l.toUpperCase()),
		online,
		draining,
		offline,
		busy,
		busyOnline,
		versions,
		locDist: tallyLocations(rows),
		rolloutPct,
		fullyRolled,
		belowFloor,
		degraded,
	};
}

/** Fleet observability payload: the pool cards plus whether a real cloud provider is wired
 *  (when false, pools are advisory — the manual provider only logs desired actions). */
export interface FleetOverview {
	pools: FleetPoolView[];
	/** `FLEET_PROVIDER=hcloud` — the controller actually provisions VMs. */
	fleetProviderActive: boolean;
	/** The current actor may create/edit/delete pools (owner/admin) — gates the UI controls. */
	canManageFleet: boolean;
}

/** Resolve a pool's effective target version (a pinned version wins; else the channel
 *  resolves to the newest release). */
function targetVersionFor(pool: FleetPool, latest: string | null): string | null {
	if (pool.version) return pool.version;
	return pool.channel ? latest : null;
}

/**
 * Read Fleet observability: every configured warm pool (including paused ones) joined with
 * its observed managed runners — capacity, rollout, version + location distribution, health.
 * Empty `pools` when none are configured → the UI shows the empty state. Visible to anyone
 * who can view runners; the cards are read-only (mutations gate on the `fleet` resource).
 */
export async function getFleetPoolViews(): Promise<FleetOverview> {
	// Hosted tenants don't operate the managed fleet — show nothing rather than our topology.
	if (!isFleetOperatorDeployment()) {
		return { pools: [], fleetProviderActive: false, canManageFleet: false };
	}
	const actor = await authorize("view", { type: "runner" });
	// Non-throwing capability probe (no activity write) — gates the create/edit/delete UI.
	const canManageFleet = (await getPdp().can(actor, "create", { type: "fleet" })).allowed;

	const pools = await getServiceDb()
		.select()
		.from(fleetPools)
		.orderBy(asc(fleetPools.provider));
	const fleetProviderActive = process.env.FLEET_PROVIDER === "hcloud";
	if (pools.length === 0) return { pools: [], fleetProviderActive, canManageFleet };

	const latest = await latestReleaseVersion();
	const views = await Promise.all(
		pools.map(async (pool) => {
			const rows = await managedRunnerRowsForProvider(pool.provider);
			return toPoolView(pool, targetVersionFor(pool, latest), rows);
		}),
	);
	return { pools: views, fleetProviderActive, canManageFleet };
}

/** The raw stored pool rows for the editor form. Visible config (warmMin/locations) is not
 *  sensitive; mutations remain owner/admin-gated. */
export async function listFleetPoolConfigs(): Promise<FleetPool[]> {
	assertFleetOperable();
	await authorize("view", { type: "fleet" });
	return getServiceDb().select().from(fleetPools).orderBy(asc(fleetPools.provider));
}

/** Map a validated create input to the insert row (camelCase project → snake_case columns). */
function toInsertRow(input: FleetPoolCreateInput) {
	return {
		provider: input.provider,
		name: input.name ?? null,
		warm_min: input.warmMin,
		max: input.max,
		slots_per_runner: input.slotsPerRunner,
		locations: input.locations,
		min_per_location: input.minPerLocation,
		surge: input.surge,
		buffer: input.buffer,
		scale_down_grace_ticks: input.scaleDownGraceTicks,
		version: input.version ?? null,
		channel: input.version ? null : (input.channel ?? null),
	};
}

/** Build a partial update patch from a validated edit input (only set provided fields). */
function toUpdatePatch(input: FleetPoolUpdateInput): Partial<typeof fleetPools.$inferInsert> {
	const patch: Partial<typeof fleetPools.$inferInsert> = { updated_at: new Date() };
	if (input.name !== undefined) patch.name = input.name ?? null;
	if (input.warmMin !== undefined) patch.warm_min = input.warmMin;
	if (input.max !== undefined) patch.max = input.max;
	if (input.slotsPerRunner !== undefined) patch.slots_per_runner = input.slotsPerRunner;
	if (input.locations !== undefined) patch.locations = input.locations;
	if (input.minPerLocation !== undefined) patch.min_per_location = input.minPerLocation;
	if (input.surge !== undefined) patch.surge = input.surge;
	if (input.buffer !== undefined) patch.buffer = input.buffer;
	if (input.scaleDownGraceTicks !== undefined)
		patch.scale_down_grace_ticks = input.scaleDownGraceTicks;
	// version + channel are mutually exclusive: a version pin clears the channel.
	if (input.version !== undefined || input.channel !== undefined) {
		patch.version = input.version ?? null;
		patch.channel = input.version ? null : (input.channel ?? null);
	}
	return patch;
}

/** Create a warm pool. Provisions real VMs once a cloud provider is wired, so it's gated to
 *  owner/admin (the `fleet` resource). Wakes the controller to converge immediately. */
export async function createFleetPool(input: FleetPoolCreateInput): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("create", { type: "fleet" });
	const data = fleetPoolCreateSchema.parse(input);
	const [row] = await getServiceDb()
		.insert(fleetPools)
		.values(toInsertRow(data))
		.returning();
	wakeFleetScaler();
	revalidatePath("/dashboard/runners");
	return row;
}

/** Edit a warm pool's project (resize, pin a version, change locations). Converges live. */
export async function updateFleetPool(
	id: string,
	input: FleetPoolUpdateInput,
): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("edit", { type: "fleet", id });
	const data = fleetPoolUpdateSchema.parse(input);
	const [row] = await getServiceDb()
		.update(fleetPools)
		.set(toUpdatePatch(data))
		.where(eq(fleetPools.id, id))
		.returning();
	wakeFleetScaler();
	revalidatePath("/dashboard/runners");
	return row;
}

/** Pause/resume a pool. Paused pools are skipped by the controller (its runners drain). */
export async function setFleetPoolEnabled(id: string, enabled: boolean): Promise<FleetPool> {
	assertFleetOperable();
	await authorize("edit", { type: "fleet", id });
	const [row] = await getServiceDb()
		.update(fleetPools)
		.set({ enabled, updated_at: new Date() })
		.where(eq(fleetPools.id, id))
		.returning();
	wakeFleetScaler();
	revalidatePath("/dashboard/runners");
	return row;
}

/** Delete a pool. The controller then drains + reaps its runners on the next tick. */
export async function deleteFleetPool(id: string): Promise<{ success: true }> {
	assertFleetOperable();
	await authorize("destroy", { type: "fleet", id });
	await getServiceDb().delete(fleetPools).where(eq(fleetPools.id, id));
	wakeFleetScaler();
	revalidatePath("/dashboard/runners");
	return { success: true };
}

/** One pool's month-to-date economics: COGS (provisioned hours × server rate) and warm-capacity
 *  utilization (job-minutes over offered capacity-minutes). */
export interface PoolEconomics {
	provider: string;
	provisionedHours: number;
	estCostEur: number;
	jobMinutes: number;
	utilizationPct: number;
}

/** Fleet COGS/utilization for the current month, per pool + totals. Honest primitives only —
 *  no margin (that needs FX + plan-aware revenue). Manager-only (owner/admin). */
export interface FleetEconomics {
	window: { from: string; to: string };
	serverType: string;
	hourlyRateEur: number;
	pools: PoolEconomics[];
	totals: { provisionedHours: number; estCostEur: number; jobMinutes: number };
}

/**
 * Month-to-date COGS + utilization for the managed fleet. Gated on `fleet:create` — the same
 * owner/admin capability `canManageFleet` is derived from — because cost/margin data must not
 * reach viewers/operators (it's the manager gate, not a literal "create").
 */
export async function getFleetEconomics(): Promise<FleetEconomics> {
	assertFleetOperable();
	await authorize("create", { type: "fleet" });

	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const db = getServiceDb();

	const [poolRows, hoursRows, minRows] = await Promise.all([
		db
			.select({ provider: fleetPools.provider, slots: fleetPools.slots_per_runner })
			.from(fleetPools),
		provisionedHoursByProvider(db, { from, to: now }),
		jobMinutesByProvider(db, { from, to: now }),
	]);

	const hoursByProvider = new Map(hoursRows.map((r) => [r.provider, r.provisioned_hours]));
	const minutesByProvider = new Map(minRows.map((r) => [r.provider, r.job_minutes]));
	const serverType = fleetServerType();

	const pools: PoolEconomics[] = poolRows.map((p) => {
		const provisionedHours = hoursByProvider.get(p.provider) ?? 0;
		const jobMinutes = minutesByProvider.get(p.provider) ?? 0;
		return {
			provider: p.provider,
			provisionedHours,
			estCostEur: estimatePoolCostEur(provisionedHours, serverType),
			jobMinutes,
			utilizationPct: computeUtilizationPct(jobMinutes, provisionedHours, p.slots),
		};
	});

	// Totals span every provider with usage (incl. "any"-attributed rows not tied to a pool).
	const totalHours = hoursRows.reduce((sum, r) => sum + r.provisioned_hours, 0);
	const totalMinutes = minRows.reduce((sum, r) => sum + r.job_minutes, 0);

	return {
		window: { from: from.toISOString(), to: now.toISOString() },
		serverType,
		hourlyRateEur: hourlyRateEur(serverType),
		pools,
		totals: {
			provisionedHours: totalHours,
			estCostEur: estimatePoolCostEur(totalHours, serverType),
			jobMinutes: totalMinutes,
		},
	};
}
