// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The deep readiness model behind /api/health — the "know the platform is alive" read side. It reports
// DB reachability, whether that DB actually holds the console's schema, OpenFGA reachability when it is
// the configured policy engine, EACH supervised background loop's liveness (from
// lib/observability/heartbeats.ts), and OTel-collector reachability when configured, and rolls them into
// one aggregate status the LB + uptime probes + the public status page (packages/status) + the (later)
// ops dashboard + the DR runbook all read off one typed shape.
//
// It is TTL-cached (compute-once, serve-cached, coalesced in-flight) so a probe storm hitting it every
// second never re-runs the DB round-trip / OTel fetch per request — the cache turns N probes/window into
// at most one compute. The build is fail-soft: any sub-check that errors is reported as a failed
// sub-check, never a thrown 500 that would hide the real status. Reading health has NO side effects
// (alerting is the reconcile watcher's job) — it's a pure read.

import { sql } from "drizzle-orm";
import { getOpenFgaConfig, isOpenFgaEnabled } from "@/lib/config/openfga";
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
/** How long the OpenFGA `/healthz` fetch may take before the engine is declared unreachable. */
const OPENFGA_PROBE_TIMEOUT_MS = 1_500;
/**
 * The table the schema check looks for. The baseline migration creates it and every tenant row hangs off
 * it, so a database without it is one the console cannot serve from — however happily it answers `SELECT 1`.
 */
const SCHEMA_SENTINEL_TABLE = "public.organization";
/** Deep-health cache window — a probe storm within this serves the cached compute (no DB re-hit). */
export const HEALTH_CACHE_TTL_MS = 5_000;

/** DB connectivity sub-check. */
export interface DbHealth {
	reachable: boolean;
	latencyMs: number | null;
	/**
	 * `pg_notification_queue_usage()` — the fraction (0–1) of Postgres's shared NOTIFY queue in use,
	 * read on the same round-trip as the connectivity probe. The console's change bus NOTIFYs on every
	 * job, billing and usage change (ADR 0005 D3); a listener that falls behind fills this queue, and a
	 * full queue makes every notifying commit FAIL. A number, null when it could not be read.
	 */
	notifyQueueUsage: number | null;
	error?: string;
}

/**
 * Schema sub-check: does the reachable database hold the console's tables? Read on the SAME round-trip as
 * the connectivity probe. A restored-but-empty cluster passes `SELECT 1` and fails this — the outage the
 * public status page's Database row exists to report (packages/status/src/probes.ts).
 */
export interface SchemaHealth {
	/** true = the sentinel table exists; false = it does not; null = not established (DB unreachable, or no answer). */
	ok: boolean | null;
}

/** OpenFGA sub-check. Only meaningful when OpenFGA is the configured policy engine. */
export interface OpenFgaHealth {
	configured: boolean;
	/** null when not configured; true/false when probed. */
	reachable: boolean | null;
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
	/**
	 * The last successful tick's numeric counts (`superviseLoop` keeps only the numbers), or null.
	 * For `realtime-bus` this is the change bus's {streams, keys, delivered, filtered, dropped} —
	 * `streams` is the open-stream leak counter (#6115).
	 */
	lastResult: Record<string, number> | null;
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

/**
 * Aggregate readiness: healthy = all ok; degraded = a loop is stuck or OpenFGA is unreachable (still serves
 * HTTP); unhealthy = the DB is down or holds no schema.
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** The full deep-health document. */
export interface DeepHealth {
	status: HealthStatus;
	ts: string;
	version: string;
	db: DbHealth;
	schema: SchemaHealth;
	openfga: OpenFgaHealth;
	loops: LoopHealthReport[];
	otel: OtelHealth;
}

/**
 * The status-page view of a deep-health document: the aggregate plus one boolean per component, and
 * nothing else — no latencies, no error strings, no loop names, no endpoints. This is what a caller holding
 * the status-probe credential (`ALETHIA_STATUS_PROBE_TOKEN`) receives; it is the contract
 * packages/status/src/probes.ts parses.
 */
export interface StatusProbeView {
	status: HealthStatus;
	mode: "status";
	ts: string;
	checks: {
		db: boolean;
		schema: boolean;
		/** null = OpenFGA is not the configured engine (authorization is the Postgres PDP). */
		openfga: boolean | null;
	};
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

/** The probe's one row as an object, or null when the driver returned no row. */
function firstRow(rows: unknown): object | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const row: unknown = rows[0];
	return typeof row === "object" && row !== null ? row : null;
}

/** The schema sentinel from the probe's one row: true/false when it says, null when it carries no boolean. */
function schemaOf(rows: unknown): SchemaHealth {
	const row = firstRow(rows);
	if (!row || !("schema_ok" in row)) return { ok: null };
	return { ok: typeof row.schema_ok === "boolean" ? row.schema_ok : null };
}

/** The NOTIFY-queue fraction from the probe's one row, or null when the row does not carry a number. */
function queueUsageOf(rows: unknown): number | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const row: unknown = rows[0];
	if (typeof row !== "object" || row === null || !("notify_queue_usage" in row)) return null;
	const value = Number(row.notify_queue_usage);
	return Number.isFinite(value) ? value : null;
}

/**
 * Probe DB connectivity AND the schema with one bounded query. Never throws — a failure is a reported
 * sub-check. `to_regclass` returns NULL (not an error) for a missing table, so an empty cluster answers the
 * query and reports `schema_ok = false` rather than looking unreachable.
 */
async function probeDb(): Promise<{ db: DbHealth; schema: SchemaHealth }> {
	const startedAt = Date.now();
	try {
		const rows = await withTimeout(
			getServiceDb().execute(
				sql`select pg_notification_queue_usage() as notify_queue_usage, to_regclass(${SCHEMA_SENTINEL_TABLE}) is not null as schema_ok`,
			),
			DB_PROBE_TIMEOUT_MS,
			"db",
		);
		return {
			db: { reachable: true, latencyMs: Date.now() - startedAt, notifyQueueUsage: queueUsageOf(rows) },
			schema: schemaOf(rows),
		};
	} catch (err) {
		return {
			db: {
				reachable: false,
				latencyMs: null,
				notifyQueueUsage: null,
				error: err instanceof Error ? err.message : String(err),
			},
			schema: { ok: null },
		};
	}
}

/** True when an OpenFGA `/healthz` body says the server is serving. */
function isServing(body: unknown): boolean {
	return typeof body === "object" && body !== null && "status" in body && body.status === "SERVING";
}

/**
 * OpenFGA reachability, when it is the configured policy engine: `GET <apiUrl>/healthz` must answer 2xx
 * with `{"status":"SERVING"}`. Unconfigured ⇒ `{configured:false}` (the Postgres PDP decides, and the DB
 * check already covers it). Never throws.
 */
async function probeOpenFga(): Promise<OpenFgaHealth> {
	if (!isOpenFgaEnabled()) return { configured: false, reachable: null };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OPENFGA_PROBE_TIMEOUT_MS);
	try {
		const base = getOpenFgaConfig().apiUrl.replace(/\/+$/, "");
		const res = await fetch(`${base}/healthz`, { method: "GET", signal: controller.signal });
		const body: unknown = await res.json().catch(() => null);
		if (res.ok && isServing(body)) return { configured: true, reachable: true };
		return { configured: true, reachable: false, error: `healthz answered HTTP ${res.status}` };
	} catch (err) {
		return { configured: true, reachable: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
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
			lastResult: hb.lastResult,
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

/**
 * Roll the sub-checks into one aggregate: DB down or schema missing ⇒ unhealthy (the instance cannot serve);
 * OpenFGA unreachable or any loop degraded ⇒ degraded; else healthy. An unestablished schema (`ok: null`)
 * does not move the aggregate — only a definite "the table is not there" does.
 *
 * OpenFGA is `degraded`, not `unhealthy`, deliberately: `unhealthy` is a 503, and every instance shares
 * the one OpenFGA server, so a blip there would 503 the whole fleet out of the load balancer at once. The
 * status page still reports it as its own Authorization row.
 */
function aggregate(db: DbHealth, schema: SchemaHealth, openfga: OpenFgaHealth, loops: LoopHealthReport[]): HealthStatus {
	if (!db.reachable || schema.ok === false) return "unhealthy";
	if (openfga.configured && openfga.reachable === false) return "degraded";
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
		const [{ db, schema }, openfga, otel] = await Promise.all([probeDb(), probeOpenFga(), probeOtel()]);
		const loops = loopReports(now);
		return {
			status: aggregate(db, schema, openfga, loops),
			ts: now.toISOString(),
			version: process.env.ALETHIA_VERSION ?? "dev",
			db,
			schema,
			openfga,
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
				notifyQueueUsage: null,
				error: `health computation failed: ${err instanceof Error ? err.message : String(err)}`,
			},
			schema: { ok: null },
			openfga: { configured: false, reachable: null },
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

/**
 * Project a deep-health document onto the status-page view: one boolean per component. `schema` is true
 * only when the sentinel table was positively seen; an unestablished schema reads false, because the page
 * must never green a component nobody measured.
 */
export function statusProbeView(health: DeepHealth): StatusProbeView {
	return {
		status: health.status,
		mode: "status",
		ts: health.ts,
		checks: {
			db: health.db.reachable,
			schema: health.schema.ok === true,
			openfga: health.openfga.configured ? health.openfga.reachable === true : null,
		},
	};
}

/** Reset the TTL cache — test-only. */
export function __resetHealthCache(): void {
	cache = null;
	inflight = null;
}
