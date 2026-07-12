// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// General loop-supervision registry — the "know the platform is alive" substrate. It GENERALIZES the
// per-reconciler heartbeat seam (lib/reconcile/heartbeat.ts) to EVERY unsupervised setInterval loop the
// console runs at startup (instrumentation.ts): stale-job recovery, the fleet scaler, the alert-delivery
// sweep, the connection sweep, and the B2c reconcile loop. Each loop wraps its tick in `superviseLoop`,
// which stamps last-run / last-success / last-error (+ message + duration + counts) into a cheap
// in-process map — no DB write per tick, so a high-frequency loop adds no query load. The /api/health
// readiness endpoint + the (later) ops dashboard + the DR runbook read this to answer "is every loop
// still ticking, and did its last pass succeed?".
//
// Liveness is INTERVAL-AWARE: a loop is DEGRADED once it has gone longer than `degradedMultiplier ×` its
// own declared interval without a success — so a 60s loop and a 15m loop have different "stuck" windows
// off the same clock. `evaluateHeartbeatAlerts` (run by the reconcile watcher tick, and never by a probe)
// raises a throttled `system.platform.loop_degraded` alert exactly ONCE per degraded episode (an
// in-memory episode latch), and a `loop_recovered` when it comes back — so a persistently-broken loop
// can never alert-storm. It is deliberately process-local (this instance's liveness), not persisted.

import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";

const hlog = log.child({ component: "heartbeats" });

/** Health of a supervised loop, derived from its heartbeat + declared interval. */
export type Liveness =
	/** Registered but has not completed its first run yet (still inside the degraded window). */
	| "starting"
	/** Succeeded within `degradedMultiplier ×` its interval. */
	| "ok"
	/** Has not succeeded within `degradedMultiplier ×` its interval (stuck, or erroring every tick). */
	| "degraded";

/** Liveness + last-outcome record for one supervised loop. */
export interface LoopHeartbeat {
	/** Stable loop id, e.g. "job-recovery". */
	id: string;
	/** The loop's declared tick cadence (ms) — the unit the degraded window is measured in. */
	intervalMs: number;
	/** DEGRADED once no success within this many intervals. */
	degradedMultiplier: number;
	/** When the loop was first registered (the liveness anchor before any success). */
	createdAt: string;
	/** When the loop last STARTED a tick (ISO). */
	lastRunAt: string | null;
	/** When the loop last completed a tick WITHOUT throwing (ISO). */
	lastSuccessAt: string | null;
	/** When the loop's tick last threw (ISO). */
	lastErrorAt: string | null;
	/** The last error's message (kept for forensics; not cleared on a later success). */
	lastError: string | null;
	/** Wall-clock duration of the most recent tick. */
	lastDurationMs: number | null;
	/** Total ticks (success + failure) since process start. */
	runs: number;
	/** Total failed ticks since process start. */
	failures: number;
	/** Optional structured counts the tick returned (e.g. `{ checked, disconnected }`), for the dashboard. */
	lastResult: Record<string, number> | null;
}

/** Default: DEGRADED after 3 missed intervals without a success. */
const DEFAULT_DEGRADED_MULTIPLIER = 3;

const globalForHeartbeats = globalThis as unknown as {
	__alethiaLoopHeartbeats?: Map<string, LoopHeartbeat>;
	/** Per-loop episode latch: true while we've already alerted for the current degraded episode. */
	__alethiaLoopAlerted?: Map<string, boolean>;
};

/** The shared registry (one entry per loop id), on globalThis so it survives HMR + is process-wide. */
function registry(): Map<string, LoopHeartbeat> {
	globalForHeartbeats.__alethiaLoopHeartbeats ??= new Map();
	return globalForHeartbeats.__alethiaLoopHeartbeats;
}

/** The degraded-episode latch map (drives one-alert-per-episode throttling). */
function alertLatch(): Map<string, boolean> {
	globalForHeartbeats.__alethiaLoopAlerted ??= new Map();
	return globalForHeartbeats.__alethiaLoopAlerted;
}

/**
 * Register (or update the metadata of) a supervised loop. Call it from the loop's `start*` function so
 * /health can show the loop as `starting` with its interval BEFORE the first tick lands. Idempotent —
 * re-registering keeps the accumulated counters and only refreshes interval/multiplier.
 */
export function registerLoop(
	id: string,
	opts: { intervalMs: number; degradedMultiplier?: number },
): LoopHeartbeat {
	const reg = registry();
	const existing = reg.get(id);
	if (existing) {
		existing.intervalMs = opts.intervalMs;
		existing.degradedMultiplier =
			opts.degradedMultiplier ?? existing.degradedMultiplier;
		return existing;
	}
	const hb: LoopHeartbeat = {
		id,
		intervalMs: opts.intervalMs,
		degradedMultiplier: opts.degradedMultiplier ?? DEFAULT_DEGRADED_MULTIPLIER,
		createdAt: new Date().toISOString(),
		lastRunAt: null,
		lastSuccessAt: null,
		lastErrorAt: null,
		lastError: null,
		lastDurationMs: null,
		runs: 0,
		failures: 0,
		lastResult: null,
	};
	reg.set(id, hb);
	return hb;
}

/** Get the heartbeat, auto-registering with a 60s default if a loop supervised before it registered. */
function ensure(id: string): LoopHeartbeat {
	return registry().get(id) ?? registerLoop(id, { intervalMs: 60_000 });
}

/** Narrow an arbitrary tick result to the numeric-count shape the dashboard shows (else null). */
function asCounts(value: unknown): Record<string, number> | null {
	if (value === null || typeof value !== "object") return null;
	const counts: Record<string, number> = {};
	for (const [key, val] of Object.entries(value)) {
		if (typeof val === "number") counts[key] = val;
	}
	return Object.keys(counts).length > 0 ? counts : null;
}

/**
 * Run one loop tick under supervision: stamp last-run, run `fn`, stamp last-success or last-error
 * (never propagating a throw — a setInterval host must never get an unhandled rejection), and return
 * the tick's result (or undefined on throw). This is the single wrapper every supervised loop uses.
 * Stamping is a handful of in-memory field writes — no DB round-trip — so it adds no per-tick load.
 */
export async function superviseLoop<T>(
	id: string,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	const hb = ensure(id);
	const startedAt = Date.now();
	hb.lastRunAt = new Date(startedAt).toISOString();
	hb.runs += 1;
	try {
		const result = await fn();
		hb.lastDurationMs = Date.now() - startedAt;
		hb.lastSuccessAt = new Date().toISOString();
		hb.lastResult = asCounts(result);
		return result;
	} catch (err) {
		hb.lastDurationMs = Date.now() - startedAt;
		hb.failures += 1;
		hb.lastErrorAt = new Date().toISOString();
		hb.lastError = err instanceof Error ? err.message : String(err);
		hlog.error("supervised loop tick failed", { loop: id, err });
		return undefined;
	}
}

/** Snapshot of every supervised loop's heartbeat (for /health + the ops dashboard). Deep-copied. */
export function getLoopHeartbeats(): LoopHeartbeat[] {
	return [...registry().values()].map((hb) => ({ ...hb }));
}

/**
 * Derive a loop's liveness from its heartbeat + declared interval. The anchor is the last success (or,
 * before any success, the registration time), so a loop that stops stamping — whether stuck (never
 * ticks) or erroring every tick (ticks but never succeeds) — ages past `degradedMultiplier ×
 * intervalMs` and flips to DEGRADED; a single transient error self-heals on the next success.
 */
export function livenessOf(hb: LoopHeartbeat, now: Date = new Date()): Liveness {
	const thresholdMs = hb.intervalMs * hb.degradedMultiplier;
	const anchor = hb.lastSuccessAt
		? new Date(hb.lastSuccessAt).getTime()
		: new Date(hb.createdAt).getTime();
	const age = now.getTime() - anchor;
	if (!hb.lastRunAt && age <= thresholdMs) return "starting";
	if (age > thresholdMs) return "degraded";
	return "ok";
}

/** Milliseconds since the loop last succeeded (null if it never has). */
export function ageMsOf(hb: LoopHeartbeat, now: Date = new Date()): number | null {
	if (!hb.lastSuccessAt) return null;
	return now.getTime() - new Date(hb.lastSuccessAt).getTime();
}

/**
 * The supervisor pass: evaluate every loop's liveness and raise a throttled platform alert on the
 * ok→degraded edge (and clear it on degraded→ok). Called by the reconcile watcher tick (a real 60s
 * cadence independent of any probe) — NOT by /health, so reading health has no alerting side effects.
 *
 * Throttling is two-layered: an in-memory episode latch fires AT MOST ONE `loop_degraded` per degraded
 * episode (not once per tick), and the alert rule's own `throttle_seconds` collapses repeats across app
 * instances. Alerts route to the platform operator's org via `ALETHIA_PLATFORM_ALERT_ORG_ID`; when it's
 * unset the degradation is still logged + surfaced in /health, we just don't fan out to a channel.
 */
export function evaluateHeartbeatAlerts(now: Date = new Date()): void {
	const orgId = process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	const latch = alertLatch();
	for (const hb of registry().values()) {
		const live = livenessOf(hb, now);
		const alreadyAlerted = latch.get(hb.id) ?? false;
		if (live === "degraded" && !alreadyAlerted) {
			latch.set(hb.id, true);
			hlog.error("background loop degraded", {
				loop: hb.id,
				lastError: hb.lastError,
				lastSuccessAt: hb.lastSuccessAt,
				failures: hb.failures,
			});
			if (orgId) {
				emitAlertEventSafe(orgId, "system.platform.loop_degraded", {
					title: `Background loop degraded: ${hb.id}`,
					summary:
						hb.lastError ??
						`No successful run within ${hb.degradedMultiplier}× its ${Math.round(hb.intervalMs / 1000)}s interval.`,
					severity: "critical",
					resource_type: "loop",
					resource_id: hb.id,
				});
			}
		} else if (live === "ok" && alreadyAlerted) {
			latch.set(hb.id, false);
			hlog.info("background loop recovered", { loop: hb.id });
			if (orgId) {
				emitAlertEventSafe(orgId, "system.platform.loop_recovered", {
					title: `Background loop recovered: ${hb.id}`,
					severity: "info",
					resource_type: "loop",
					resource_id: hb.id,
				});
			}
		}
	}
}

/** Reset the registry + alert latch — test-only (each test file wants a clean slate). */
export function __resetLoopHeartbeats(): void {
	registry().clear();
	alertLatch().clear();
}
