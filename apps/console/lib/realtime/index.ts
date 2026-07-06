// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/config/database";

// Realtime fan-out over Postgres LISTEN/NOTIFY. A Postgres trigger does
// pg_notify('<channel>', json) on insert; each app instance holds ONE dedicated LISTEN
// connection per channel and dispatches to its SSE subscribers — so it scales to
// multiple instances with no Redis. Two channels are wired today: `job_logs` (the
// runner's insert_job_log() RPC → {jobId, logId}) and `support_messages`
// (notify_support_message() → {caseId, messageId}). The ee/ tier swaps a Redis-backed
// impl in behind these interfaces (see dataroom/spec/mvp/07-auth-rbac-sso.md).

/**
 * A per-channel realtime transport: subscribe a callback to a routing key (e.g. a
 * jobId or caseId) and receive the notify value dispatched only to that key.
 */
export interface ChannelTransport<TValue> {
	/** Subscribe to values for `key`. Returns an unsubscribe function. */
	subscribe(key: string, cb: (value: TValue) => void): () => void;
}

/** The job_logs notify payload: a numeric log id keyed by jobId. */
export interface JobLogPayload {
	jobId: string;
	logId: number;
}

/** The support_messages notify payload: a message uuid keyed by caseId. */
export interface SupportMessagePayload {
	caseId: string;
	messageId: string;
}

/** A parsed notify → the routing `key` and the `value` handed to that key's subscribers. */
type Route<TValue> = (payload: unknown) => { key: string; value: TValue } | null;

/**
 * Generic single-LISTEN-connection transport: one dedicated `max:1` Postgres LISTEN
 * per channel per app instance, keyed fan-out to subscribers, and lazy start with a
 * retry-on-failed-LISTEN reset. Parameterised by channel + a payload router so each
 * channel (job_logs, support_messages, …) reuses the exact same plumbing.
 */
class PgListenTransport<TValue> implements ChannelTransport<TValue> {
	private readonly listeners = new Map<string, Set<(value: TValue) => void>>();
	private started = false;
	private sql: ReturnType<typeof postgres> | null = null;

	constructor(
		private readonly channel: string,
		private readonly route: Route<TValue>,
	) {}

	/** Lazily opens the single LISTEN connection on first subscribe. */
	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.sql = postgres(getDatabaseConfig().serviceUrl, {
			max: 1,
			prepare: false,
		});
		this.sql
			.listen(this.channel, (payload) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch {
					return; // ignore malformed payloads
				}
				const routed = this.route(parsed);
				if (!routed) return;
				const subs = this.listeners.get(routed.key);
				if (!subs) return;
				for (const cb of subs) cb(routed.value);
			})
			.catch((err) => {
				console.error(`[realtime] LISTEN ${this.channel} failed:`, err);
				this.started = false; // allow a retry on the next subscribe
			});
	}

	subscribe(key: string, cb: (value: TValue) => void): () => void {
		this.ensureStarted();
		let set = this.listeners.get(key);
		if (!set) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(cb);
		return () => {
			const current = this.listeners.get(key);
			if (!current) return;
			current.delete(cb);
			if (current.size === 0) this.listeners.delete(key);
		};
	}
}

/**
 * Parses a `job_logs` notify into {key: jobId, value: logId}. Returns null (ignored)
 * for a malformed payload or one missing jobId/logId. A string logId is coerced to a
 * number; logId 0 is treated as present.
 */
function routeJobLog(payload: unknown): { key: string; value: number } | null {
	if (typeof payload !== "object" || payload === null) return null;
	if (!("jobId" in payload) || !("logId" in payload)) return null;
	const jobId = payload.jobId;
	const logId = payload.logId;
	if (typeof jobId !== "string" || jobId.length === 0) return null;
	if (logId === undefined || logId === null) return null;
	if (typeof logId !== "number" && typeof logId !== "string") return null;
	return { key: jobId, value: Number(logId) };
}

/**
 * Parses a `support_messages` notify into {key: caseId, value: messageId}. Returns
 * null (ignored) for a malformed payload or one missing the two uuid string fields.
 */
function routeSupportMessage(payload: unknown): { key: string; value: string } | null {
	if (typeof payload !== "object" || payload === null) return null;
	if (!("caseId" in payload) || !("messageId" in payload)) return null;
	const caseId = payload.caseId;
	const messageId = payload.messageId;
	if (typeof caseId !== "string" || caseId.length === 0) return null;
	if (typeof messageId !== "string" || messageId.length === 0) return null;
	return { key: caseId, value: messageId };
}

/**
 * The job-log realtime transport. `subscribe(jobId, cb)` delivers new numeric log ids
 * for a job. Kept as its own named interface for back-compat with existing callers.
 */
export interface RealtimeTransport {
	/** Subscribe to new log ids for a job. Returns an unsubscribe function. */
	subscribe(jobId: string, cb: (logId: number) => void): () => void;
}

const globalForRealtime = globalThis as unknown as {
	__alethiaRealtime?: RealtimeTransport;
	__alethiaWake?: WakeTransport;
	__alethiaSupport?: ChannelTransport<string>;
};

/** The process-wide job-log realtime transport (HMR/instance-safe singleton). */
export function getRealtimeTransport(): RealtimeTransport {
	if (!globalForRealtime.__alethiaRealtime) {
		globalForRealtime.__alethiaRealtime = new PgListenTransport<number>(
			"job_logs",
			routeJobLog,
		);
	}
	return globalForRealtime.__alethiaRealtime;
}

/**
 * The process-wide support-message realtime transport (HMR/instance-safe singleton).
 * `subscribe(caseId, cb)` delivers the messageId of each new row inserted on that case;
 * the SSE route then fetches the row (visible messages only) and emits it.
 */
export function getSupportMessageTransport(): ChannelTransport<string> {
	if (!globalForRealtime.__alethiaSupport) {
		globalForRealtime.__alethiaSupport = new PgListenTransport<string>(
			"support_messages",
			routeSupportMessage,
		);
	}
	return globalForRealtime.__alethiaSupport;
}

// ── Runner wake fan-out ──────────────────────────────────────────────────────
// Push dispatch: the jobs_runner_wake trigger does pg_notify('runner_wake', …) when
// a job becomes QUEUED. Each app instance holds ONE LISTEN connection and broadcasts
// to its connected-runner SSE subscribers, who then call claim_next_job. Separate
// connection from job_logs (postgres-js dedicates a connection per LISTEN).

export interface WakeTransport {
	/** Subscribe to "a job is available" wakes. Returns an unsubscribe function. */
	subscribe(cb: () => void): () => void;
}

class PgWakeTransport implements WakeTransport {
	private readonly subs = new Set<() => void>();
	private started = false;
	private sql: ReturnType<typeof postgres> | null = null;

	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.sql = postgres(getDatabaseConfig().serviceUrl, {
			max: 1,
			prepare: false,
		});
		this.sql
			.listen("runner_wake", () => {
				for (const cb of this.subs) cb();
			})
			.catch((err) => {
				console.error("[realtime] LISTEN runner_wake failed:", err);
				this.started = false; // allow a retry on the next subscribe
			});
	}

	subscribe(cb: () => void): () => void {
		this.ensureStarted();
		this.subs.add(cb);
		return () => {
			this.subs.delete(cb);
		};
	}
}

/** The process-wide runner-wake transport (HMR/instance-safe singleton). */
export function getWakeTransport(): WakeTransport {
	if (!globalForRealtime.__alethiaWake) {
		globalForRealtime.__alethiaWake = new PgWakeTransport();
	}
	return globalForRealtime.__alethiaWake;
}
