// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The deep readiness model behind /api/health — the "know the platform is alive" read side. It reports
// DB reachability, EACH supervised background loop's liveness (from lib/observability/heartbeats.ts), and
// OTel-collector reachability when configured, and rolls them into one aggregate status the LB + uptime
// probes + the (later) ops dashboard + the DR runbook all read off one typed shape.
//
// It is TTL-cached (compute-once, serve-cached, coalesced in-flight) so a probe storm hitting it every
// second never re-runs the DB round-trip / OTel fetch per request — the cache turns N probes/window into
// at most one compute. The build is fail-soft: any sub-check that errors is reported as a failed
// sub-check, never a thrown 500 that would hide the real status. Reading health has NO side effects
// (alerting is the reconcile watcher's job) — it's a pure read.

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	ageMsOf,
	getLoopHeartbeats,
	type Liveness,
	livenessOf,
} from "@/lib/observability/heartbeats";
import { getHeartbeats as getReconcileTaskHeartbeats } from "@/lib/reconcile/heartbeat";

/** The supervision id of the reconcile loop (its per-reconciler tasks are attached as detail). */
const RECONCILE_LOOP_ID = "reconcile";

/** How long a `select 1` may hang before the DB is declared unreachable (a stuck DB must not hang the probe). */
const DB_PROBE_TIMEOUT_MS = 2_000;
/** How long the best-effort OTel reachability fetch may take. */
const OTEL_PROBE_TIMEOUT_MS = 1_500;
/** Deep-health cache window — a probe storm within this serves the cached compute (no DB re-hit). */
export const HEALTH_CACHE_TTL_MS = 5_000;

/** DB connectivity sub-check. */
export interface DbHealth {
	reachable: boolean;
	latencyMs: number | null;
	error?: string;
}

/** One reconcile sub-task's last outcome (attached under the reconcile loop for dashboard detail). */
export interface ReconcileTaskHealth {
	id: string;
	lastRunAt: string | null;
	lastSuccessAt: string | null;
	lastErrorAt: string | null;
	lastError: string | null;
	runs: number;
	failures: number;
}

/** One supervised loop's liveness report. */
export interface LoopHealthReport {
	id: string;
	status: Liveness;
	intervalMs: number;
	lastRunAt: string | null;
	lastSuccessAt: string | null;
	lastErrorAt: string | null;
	lastError: string | null;
	/** Milliseconds since the loop last succeeded (null if never). */
	ageMs: number | null;
	runs: number;
	failures: number;
	/** Only present for the reconcile loop: its per-reconciler sub-task heartbeats. */
	tasks?: ReconcileTaskHealth[];
}

/** OTel collector reachability (best-effort; never drives the aggregate to unhealthy). */
export interface OtelHealth {
	configured: boolean;
	/** null when not configured; true/false when probed. */
	reachable: boolean | null;
	endpoint?: string;
	error?: string;
}

/** Aggregate readiness: healthy = all ok, degraded = a loop is stuck (still serves), unhealthy = DB down. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** The full deep-health document. */
export interface DeepHealth {
	status: HealthStatus;
	ts: string;
	version: string;
	db: DbHealth;
	loops: LoopHealthReport[];
	otel: OtelHealth;
}

/** Reject a promise if it hasn't settled within `ms` (so a hung DB can't stall the whole probe). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/** Probe DB connectivity with a bounded `select 1`. Never throws — a failure is a reported sub-check. */
async function probeDb(): Promise<DbHealth> {
	const startedAt = Date.now();
	try {
		await withTimeout(getServiceDb().execute(sql`select 1`), DB_PROBE_TIMEOUT_MS, "db");
		return { reachable: true, latencyMs: Date.now() - startedAt };
	} catch (err) {
		return {
			reachable: false,
			latencyMs: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Best-effort OTel collector reachability. Unset endpoint ⇒ `{configured:false}` (never a failure). Any
 * HTTP response (even 4xx/5xx) means the collector is reachable — only a network error / timeout is
 * unreachable. NEVER throws out, and NEVER drives the aggregate status: a collector blip must not fail
 * the whole readiness check.
 */
async function probeOtel(): Promise<OtelHealth> {
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return { configured: false, reachable: null };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OTEL_PROBE_TIMEOUT_MS);
	try {
		await fetch(endpoint, { method: "GET", signal: controller.signal });
		return { configured: true, reachable: true, endpoint };
	} catch (err) {
		return {
			configured: true,
			reachable: false,
			endpoint,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Map the in-memory loop heartbeats (+ reconcile sub-tasks) to their liveness reports. */
function loopReports(now: Date): LoopHealthReport[] {
	return getLoopHeartbeats().map((hb) => {
		const report: LoopHealthReport = {
			id: hb.id,
			status: livenessOf(hb, now),
			intervalMs: hb.intervalMs,
			lastRunAt: hb.lastRunAt,
			lastSuccessAt: hb.lastSuccessAt,
			lastErrorAt: hb.lastErrorAt,
			lastError: hb.lastError,
			ageMs: ageMsOf(hb, now),
			runs: hb.runs,
			failures: hb.failures,
		};
		if (hb.id === RECONCILE_LOOP_ID) {
			report.tasks = getReconcileTaskHeartbeats().map((t) => ({
				id: t.task,
				lastRunAt: t.lastRunAt,
				lastSuccessAt: t.lastSuccessAt,
				lastErrorAt: t.lastErrorAt,
				lastError: t.lastError,
				runs: t.runs,
				failures: t.failures,
			}));
		}
		return report;
	});
}

/** Roll the sub-checks into one aggregate: DB down ⇒ unhealthy; any loop degraded ⇒ degraded; else healthy. */
function aggregate(db: DbHealth, loops: LoopHealthReport[]): HealthStatus {
	if (!db.reachable) return "unhealthy";
	if (loops.some((l) => l.status === "degraded")) return "degraded";
	return "healthy";
}

/**
 * Compute the deep-health document fresh (DB + loops + OTel, in parallel). NEVER throws: the sub-probes
 * catch internally, and an OUTER guard turns any unexpected fault in the aggregation/loop-report path
 * (e.g. a malformed heartbeat timestamp) into a fail-closed `unhealthy` document rather than a rejected
 * promise — a health endpoint that 500s is useless, and readiness should drain a genuinely-unknown
 * instance.
 */
async function buildDeepHealth(now: Date): Promise<DeepHealth> {
	try {
		const [db, otel] = await Promise.all([probeDb(), probeOtel()]);
		const loops = loopReports(now);
		return {
			status: aggregate(db, loops),
			ts: now.toISOString(),
			version: process.env.ALETHIA_VERSION ?? "dev",
			db,
			loops,
			otel,
		};
	} catch (err) {
		return {
			status: "unhealthy",
			ts: now.toISOString(),
			version: process.env.ALETHIA_VERSION ?? "dev",
			db: {
				reachable: false,
				latencyMs: null,
				error: `health computation failed: ${err instanceof Error ? err.message : String(err)}`,
			},
			loops: [],
			otel: { configured: false, reachable: null },
		};
	}
}

// TTL cache + in-flight coalescing (module-scoped, per server process). Concurrent probes during a
// recompute all await the SAME in-flight promise → the DB/OTel work runs exactly once per window.
let cache: { at: number; value: DeepHealth } | null = null;
let inflight: Promise<DeepHealth> | null = null;

/**
 * Get the deep-health document, served from a short-lived cache. A probe within the TTL window returns
 * the cached compute (no DB round-trip); a probe during an active recompute joins the in-flight promise
 * rather than starting a second one — so an uptime monitor hitting this every second adds no DB load.
 */
export async function getDeepHealth(now: Date = new Date()): Promise<DeepHealth> {
	if (cache && Date.now() - cache.at < HEALTH_CACHE_TTL_MS) return cache.value;
	if (inflight) return inflight;
	inflight = buildDeepHealth(now)
		.then((value) => {
			cache = { at: Date.now(), value };
			return value;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/**
 * HTTP status for a deep-health result. Default scheme: 503 only when `unhealthy` (a core dependency —
 * the DB — is down, so the instance genuinely can't serve), 200 for `healthy` AND `degraded` (a stuck
 * BACKGROUND loop doesn't stop the instance serving HTTP, and 503-ing every instance on a shared
 * degradation would cascade the LB into an outage). Pass `strict` (uptime monitors that WANT a 503 on
 * degraded) to also 503 on `degraded`.
 */
export function httpStatusFor(health: DeepHealth, strict = false): number {
	if (health.status === "unhealthy") return 503;
	if (health.status === "degraded" && strict) return 503;
	return 200;
}

/** Reset the TTL cache — test-only. */
export function __resetHealthCache(): void {
	cache = null;
	inflight = null;
}
