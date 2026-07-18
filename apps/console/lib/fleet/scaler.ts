// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet Controller's loop host. A sibling to the stale-job recovery loop: each app
// instance runs the 60s tick, plus an on-demand wake (wakeFleetScaler) when a job is enqueued.
// Default (no FLEET_POOLS) → no-op. See dataroom/spec/mvp/26.
//
// Concurrency has two layers:
//   • WITHIN a process, scheduleTick() serializes passes (coalescing the ~15 fire-and-forget wakes)
//     so overlapping wakes never race a duplicate read→plan→act.
//   • ACROSS replicas, every replica runs the interval, but the tick first tries to hold the single
//     fleet-controller leader LEASE (tryBecomeFleetLeader); only the holder reconciles, so N replicas
//     don't each hit the cloud provider API + DB every tick, and can't plan off divergent snapshots.
//     A time-bounded lease (not a held advisory-lock tx) means nothing sits idle-in-transaction across
//     the tick's slow cloud calls, and a crashed leader is superseded once its lease expires. The
//     per-provider apply lock (tryFleetScaleLock, in the controller) remains as inner defense-in-depth.

import { randomUUID } from "node:crypto";
import { reconcileAll, type SurplusState } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { loadFleetPools, reapDeletedPools } from "@/lib/fleet/pools-db";
import { getFleetProvider } from "@/lib/fleet/provider";
import { tryBecomeFleetLeader } from "@/lib/fleet/queue";
import {
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";
import { log } from "@/lib/observability/log";
import { sweepBootstrapTokens } from "@/lib/runners/bootstrap-token";

const flog = log.child({ component: "fleet" });

const TICK_INTERVAL_MS = 60_000;

/** This replica's stable leader-lease identity (regenerated each process start). */
const LEADER_ID = randomUUID();
/** Lease TTL — held longer than the tick interval so the leader renews each winning tick and holds
 *  across ticks; a crashed leader is superseded after at most this long. */
const LEADER_TTL_SECONDS = Math.ceil((TICK_INTERVAL_MS / 1000) * 1.5);

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const FLEET_LOOP_ID = "fleet-scaler";

declare global {
	var __alethiaFleetScaler: ReturnType<typeof setInterval> | undefined;
	/** The single in-flight reconcile pass (null when idle). Its presence is the serializer's mutex. */
	var __alethiaFleetTickInFlight: Promise<void> | null | undefined;
	/** A wake arrived while a pass was running → run exactly one follow-up after it, no matter how many. */
	var __alethiaFleetTickQueued: boolean | undefined;
}

const surplus: SurplusState = new Map();

/**
 * Serialize the reconcile tick so at most ONE pass is ever in flight. Every entry point (the 60s
 * interval and the fire-on-enqueue `wakeFleetScaler`, called from ~15 sites) routes through here.
 * If a pass is already running, this wake COALESCES into a single follow-up — it never launches a
 * second concurrent read-plan-act pass. That matters because `reconcilePool` reads the live
 * instance list, plans against it, then creates VMs (a lock-free read→plan→act): two overlapping
 * passes would each read the same stale snapshot and both create for the same backlog, over-
 * provisioning past the pool max (billable orphan VMs). Coalescing (not merely dropping the wake)
 * guarantees a signal that arrived mid-pass — a new QUEUED job or pool edit the running pass may
 * have already read past — still triggers exactly one follow-up, so the pool converges without a
 * wake-storm fanning out N parallel passes. `superviseLoop` never rejects (it swallows every
 * throw), so the `.finally` always runs → the mutex is always released → the chain can never
 * deadlock or permanently skip. State lives on `globalThis` so it stays a singleton across dev HMR
 * — and, being per-process, this serializer bounds IN-PROCESS re-entrancy only (see the file header
 * for the multi-replica ceiling / advisory-lock note).
 */
function scheduleTick(): void {
	if (globalThis.__alethiaFleetTickInFlight) {
		globalThis.__alethiaFleetTickQueued = true;
		return;
	}
	const run = (): void => {
		globalThis.__alethiaFleetTickInFlight = superviseLoop(FLEET_LOOP_ID, tick)
			.then(() => undefined)
			.finally(() => {
				globalThis.__alethiaFleetTickInFlight = null;
				if (globalThis.__alethiaFleetTickQueued) {
					globalThis.__alethiaFleetTickQueued = false;
					run();
				}
			});
	};
	run();
}

/** Starts the periodic fleet controller. Pools now live in the DB (read fresh each tick),
 *  so the loop runs whenever a database is configured — a tick with zero enabled pools is
 *  a cheap no-op, but newly-created pools converge without a restart. Each tick is
 *  heartbeat-supervised (lib/observability/heartbeats.ts). */
export function startFleetScaler(): void {
	if (globalThis.__alethiaFleetScaler) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;

	registerLoop(FLEET_LOOP_ID, { intervalMs: TICK_INTERVAL_MS });
	globalThis.__alethiaFleetScaler = setInterval(() => {
		scheduleTick();
	}, TICK_INTERVAL_MS);
}

/** Run one reconcile pass immediately (enqueue wake / presence / pool edit → fast converge). Routed
 *  through the serializer so a wake during an in-flight pass coalesces into one follow-up rather than
 *  racing a second concurrent pass (which would double-provision off a stale instance snapshot). */
export function wakeFleetScaler(): void {
	if (!globalThis.__alethiaFleetScaler) return;
	scheduleTick();
}

async function tick(): Promise<void> {
	// Cross-replica singleton: only the lease holder reconciles. A non-leader replica no-ops this tick
	// (the leader is doing the work), so the cloud provider API + fleet reads happen once per tick, not
	// once per replica. Lease acquisition is a single atomic upsert; a failure here (DB blip) simply
	// skips the tick — the next tick (or the current leader) covers it, so the fleet still converges.
	if (!(await tryBecomeFleetLeader(LEADER_ID, LEADER_TTL_SECONDS))) {
		return;
	}
	const projects = await loadFleetPools();
	await reconcileAll(projects, getFleetProvider(), makeDbDeps(), surplus);
	// Reap soft-deleted pools whose VMs have fully drained (and their runners retired). Runs AFTER
	// reconcileAll so a teardown pool's destroys are issued first; a still-draining pool is left for
	// a later tick. Best-effort — a reap hiccup must never break the reconcile loop.
	await reapDeletedPools(getFleetProvider()).catch((err) =>
		flog.error("reapDeletedPools failed", { err }),
	);
	// Best-effort GC of spent/expired per-VM bootstrap tokens (past a retry grace).
	await sweepBootstrapTokens().catch((err) =>
		flog.error("bootstrap-token sweep failed", { err }),
	);
}
