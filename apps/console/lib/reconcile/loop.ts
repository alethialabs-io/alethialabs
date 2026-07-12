// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The supervised reconcile loop — one interval host for the B2c "keep proving it + self-heal + don't
// leak" reconcilers, a sibling to the stale-job recovery / fleet / alert / connection loops in
// instrumentation.ts. It ticks every 60s and, per reconciler, runs it only when its own effective
// interval has elapsed (convergence + reaper hot; drift schedule + GC cold), each wrapped in a
// heartbeat (lib/reconcile/heartbeat.ts) so a later /health endpoint + ops dashboard can see the
// layer is alive and whether each reconciler's last pass succeeded.
//
// Every reconciler is idempotent + reconvergent (safe under concurrent app instances) and isolated:
// `runTask` catches a throw per task, so one failing reconciler never aborts its siblings in the tick.

import { getServiceDb } from "@/lib/db";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";
import {
	evaluateHeartbeatAlerts,
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";
import { log } from "@/lib/observability/log";
import { convergeEnvStatuses } from "@/lib/reconcile/converge";
import { gcFleetActions, gcJobLogs } from "@/lib/reconcile/gc";
import { getHeartbeats, isDue, runTask } from "@/lib/reconcile/heartbeat";
import { reapExpiredEphemeralEnvs } from "@/lib/reconcile/reap";

const llog = log.child({ component: "reconcile" });

/** Stable supervision id for this loop host (lib/observability/heartbeats.ts). */
export const RECONCILE_LOOP_ID = "reconcile";

/** How often the host wakes. Individual reconcilers gate themselves off their own interval below. */
const TICK_INTERVAL_MS = 60_000;

/** Per-reconciler effective cadence (min gap between runs), evaluated off the heartbeat clock. */
const INTERVALS = {
	"env-convergence": 60_000, // 1m  — cheap read + guarded CAS; keep stuck envs short-lived
	"ephemeral-reaper": 60_000, // 1m — expiry is time-sensitive
	"drift-schedule": 5 * 60_000, // 5m — the sweep itself self-gates per-env by tier cadence (hours)
	"gc-job-logs": 15 * 60_000, // 15m — bounded-batch retention GC; a backlog drains over passes
	"gc-fleet-actions": 15 * 60_000, // 15m
} as const;

const globalForReconcile = globalThis as unknown as {
	__alethiaReconcileLoop?: ReturnType<typeof setInterval>;
};

/**
 * Start the supervised reconcile loop (idempotent across HMR/instances; a no-op without a database).
 * Mirrors startStaleJobRecovery — each app instance runs its own interval and every reconciler is
 * safe to run concurrently across instances.
 */
export function startReconcileLoop(): void {
	if (globalForReconcile.__alethiaReconcileLoop) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(RECONCILE_LOOP_ID, { intervalMs: TICK_INTERVAL_MS });
	globalForReconcile.__alethiaReconcileLoop = setInterval(() => {
		void tick();
	}, TICK_INTERVAL_MS);
}

/**
 * Run one reconcile pass immediately — useful for tests + an on-demand converge after a known drop.
 * The whole pass is heartbeat-supervised at the loop level: `runTask` still isolates each reconciler
 * (a throw never aborts siblings), and after the pass we surface any sub-task that failed THIS tick as a
 * loop-level error so a persistently-failing reconciler flips the reconcile loop to DEGRADED in /health.
 * The tick then runs the supervisor pass (`evaluateHeartbeatAlerts`) — the real 60s watcher over EVERY
 * loop (not just this one), independent of any /health probe, that raises the throttled degraded alerts.
 */
export async function tick(now: Date = new Date()): Promise<void> {
	const tickStartedAt = Date.now();
	await superviseLoop(RECONCILE_LOOP_ID, async () => {
		const db = getServiceDb();

		// Env-status convergence backstop (B2a): settle envs stuck in-flight behind a terminal job.
		if (isDue("env-convergence", INTERVALS["env-convergence"], now)) {
			await runTask("env-convergence", () => convergeEnvStatuses(db));
		}
		// Ephemeral-env reaper: enqueue DESTROY for expired ephemeral envs (idempotent + reconvergent).
		if (isDue("ephemeral-reaper", INTERVALS["ephemeral-reaper"], now)) {
			await runTask("ephemeral-reaper", () => reapExpiredEphemeralEnvs(db, now));
		}
		// Periodic drift scheduler ("keep proving it"): enqueue DETECT_DRIFT per due ACTIVE env.
		if (isDue("drift-schedule", INTERVALS["drift-schedule"], now)) {
			await runTask("drift-schedule", () => sweepDriftSchedule(now));
		}
		// Retention GC (best-effort, bounded batch): job_logs + fleet_actions ledger.
		if (isDue("gc-job-logs", INTERVALS["gc-job-logs"], now)) {
			await runTask("gc-job-logs", () => gcJobLogs(db));
		}
		if (isDue("gc-fleet-actions", INTERVALS["gc-fleet-actions"], now)) {
			await runTask("gc-fleet-actions", () => gcFleetActions(db));
		}

		// Bubble any reconciler that FAILED during this pass up to the loop heartbeat (runTask already
		// recorded + isolated it per-task). This keeps the loop "alive" for a transient blip but flips it
		// DEGRADED if a reconciler keeps failing — without ever aborting a sibling in the same tick.
		const failedThisTick = getHeartbeats().filter(
			(h) => h.lastErrorAt && new Date(h.lastErrorAt).getTime() >= tickStartedAt,
		);
		if (failedThisTick.length > 0) {
			throw new Error(
				`reconcile: ${failedThisTick.map((h) => h.task).join(", ")} failed this pass`,
			);
		}
		llog.debug("reconcile tick complete");
	});

	// Watcher pass: evaluate liveness of EVERY supervised loop and raise throttled degraded alerts.
	evaluateHeartbeatAlerts(now);
}
