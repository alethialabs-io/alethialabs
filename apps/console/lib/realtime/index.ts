// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/config/database";
import { log } from "@/lib/observability/log";
import {
	type ChangeNotice,
	keysFor,
	parseNotice,
	type SelfTestNotice,
} from "./routing";

const rtlog = log.child({ component: "realtime" });

// Realtime fan-out over Postgres LISTEN/NOTIFY. A Postgres trigger or RPC does
// pg_notify('<channel>', json); each app instance holds ONE dedicated LISTEN connection
// per channel and dispatches to its SSE subscribers — so it scales to multiple instances
// with no Redis. Channels wired here: `job_logs` (insert_job_log() → {jobId, logId}),
// `support_messages` (notify_support_message() → {caseId, messageId}), `runner_cancel`,
// `runner_wake`, and `alethia_change` — the console's change bus (#6115: emit_change() →
// {t, id, o, u, p}, consumed by lib/realtime/bus.ts). The ee/ tier swaps a Redis-backed
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

/**
 * A parsed notify → the routing key(s) and the `value` handed to their subscribers. A notice may
 * route to several keys (the change bus: an org arm and an owner arm); a subscriber registered on
 * more than one of them is still called ONCE per notice.
 */
type Route<TValue> = (
	payload: unknown,
) => { key: string | readonly string[]; value: TValue } | null;

/** Where a transport's LISTEN connection points, read when the connection is opened. */
interface TransportOptions {
	url?: () => string;
}

/**
 * Generic single-LISTEN-connection transport: one dedicated `max:1` Postgres LISTEN
 * per channel per app instance, keyed fan-out to subscribers, and lazy start with a
 * retry-on-failed-LISTEN reset. Parameterised by channel + a payload router so each
 * channel (job_logs, support_messages, alethia_change, …) reuses the exact same plumbing.
 *
 * Two hooks exist for the change bus (lib/realtime/bus.ts), which needs to hear EVERY notice (its
 * cursor counts notices for keys nobody is subscribed to right now) and needs to know when it may
 * have missed some:
 *
 * - {@link tap} sees every routed notice, whatever its keys.
 * - {@link onReconnect} fires on every successful LISTEN after the first one — postgres-js re-LISTENs
 *   by itself when the connection drops (and calls `onlisten` again), and {@link restart} opens a new
 *   connection. Either way NOTIFY is fire-and-forget to current listeners, so the gap is unknowable
 *   and the only honest answer is a resync.
 *
 * What it CANNOT see: postgres-js swallows a failed re-LISTEN (`.catch(() => {})` in its `onclose`),
 * after which this transport is deaf and says nothing. Only a round trip proves it is listening —
 * lib/realtime/self-test.ts sends one every 30 s and calls {@link restart} when it does not come back.
 */
class PgListenTransport<TValue> implements ChannelTransport<TValue> {
	private readonly listeners = new Map<string, Set<(value: TValue) => void>>();
	private readonly taps = new Set<(value: TValue) => void>();
	private readonly reconnectHooks = new Set<() => void>();
	private readonly listenWaiters = new Set<() => void>();
	private started = false;
	private listening = false;
	private everListened = false;
	private sql: ReturnType<typeof postgres> | null = null;

	constructor(
		private readonly channel: string,
		private readonly route: Route<TValue>,
		private readonly options: TransportOptions = {},
	) {}

	/** Lazily opens the single LISTEN connection on first subscribe. */
	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		const url = this.options.url?.() ?? getDatabaseConfig().serviceUrl;
		const sql = postgres(url, {
			max: 1,
			prepare: false,
		});
		this.sql = sql;
		sql
			.listen(
				this.channel,
				(payload) => this.dispatch(payload),
				() => this.onListen(sql),
			)
			.catch((err) => {
				rtlog.error("LISTEN failed", { channel: this.channel, err });
				if (this.sql !== sql) return; // a restart already replaced this client
				this.started = false; // allow a retry on the next subscribe
				this.listening = false;
				this.sql = null;
				// Close the client that failed: it holds a connection (or a connect attempt) of its own,
				// and the retry opens a fresh one. Without this every failed LISTEN leaked a client.
				void sql.end({ timeout: 1 }).catch(() => {});
			});
	}

	/** A LISTEN succeeded on `sql` (the first one, or a re-LISTEN after a dropped connection). */
	private onListen(sql: ReturnType<typeof postgres>): void {
		if (this.sql !== sql) return;
		this.listening = true;
		for (const resolve of this.listenWaiters) resolve();
		this.listenWaiters.clear();
		if (this.everListened) {
			for (const hook of this.reconnectHooks) hook();
		}
		this.everListened = true;
	}

	/** Parse, route and fan out one NOTIFY payload. */
	private dispatch(payload: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return; // ignore malformed payloads
		}
		const routed = this.route(parsed);
		if (!routed) return;
		for (const tap of this.taps) tap(routed.value);
		if (typeof routed.key === "string") {
			const subs = this.listeners.get(routed.key);
			if (!subs) return;
			for (const cb of subs) cb(routed.value);
			return;
		}
		const called = new Set<(value: TValue) => void>();
		for (const key of routed.key) {
			const subs = this.listeners.get(key);
			if (!subs) continue;
			for (const cb of subs) {
				if (called.has(cb)) continue;
				called.add(cb);
				cb(routed.value);
			}
		}
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

	/** Hear every routed notice, whatever its keys. Opens the connection. Returns the removal. */
	tap(cb: (value: TValue) => void): () => void {
		this.ensureStarted();
		this.taps.add(cb);
		return () => {
			this.taps.delete(cb);
		};
	}

	/** Called after every LISTEN that follows the first (a reconnect). Returns the removal. */
	onReconnect(cb: () => void): () => void {
		this.reconnectHooks.add(cb);
		return () => {
			this.reconnectHooks.delete(cb);
		};
	}

	/**
	 * Resolves true once the connection is LISTENing, false if it is not within `timeoutMs`. Opens
	 * the connection if it is not open.
	 */
	whenListening(timeoutMs: number): Promise<boolean> {
		this.ensureStarted();
		if (this.listening) return Promise.resolve(true);
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.listenWaiters.delete(done);
				resolve(false);
			}, timeoutMs);
			this.listenWaiters.add(done);
		});
	}

	/**
	 * Close the connection and open a new one. For a LISTEN that is provably deaf (the self-test's
	 * nonce never came back): the new connection's first LISTEN counts as a reconnect, so every
	 * {@link onReconnect} hook fires once it is up.
	 */
	restart(): void {
		this.close();
		this.ensureStarted();
	}

	/** Close the connection. The next subscribe, tap or wait opens a new one. */
	close(): void {
		const old = this.sql;
		this.sql = null;
		this.started = false;
		this.listening = false;
		if (old) void old.end({ timeout: 1 }).catch(() => {});
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
 * Parses a `runner_cancel` notify into {key: runnerId, value: jobId}. Keyed by the
 * runner id so ONLY the SSE connection for the runner that owns the job receives the
 * cancel. Returns null (ignored) for a malformed payload or one missing either uuid.
 */
function routeRunnerCancel(payload: unknown): { key: string; value: string } | null {
	if (typeof payload !== "object" || payload === null) return null;
	if (!("runner_id" in payload) || !("job_id" in payload)) return null;
	const runnerId = payload.runner_id;
	const jobId = payload.job_id;
	if (typeof runnerId !== "string" || runnerId.length === 0) return null;
	if (typeof jobId !== "string" || jobId.length === 0) return null;
	return { key: runnerId, value: jobId };
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

declare global {
	var __alethiaRealtime: RealtimeTransport | undefined;
	var __alethiaWake: WakeTransport | undefined;
	var __alethiaSupport: ChannelTransport<string> | undefined;
	var __alethiaCancel: ChannelTransport<string> | undefined;
	var __alethiaChange: ChangeTransport | undefined;
}

/** The process-wide job-log realtime transport (HMR/instance-safe singleton). */
export function getRealtimeTransport(): RealtimeTransport {
	if (!globalThis.__alethiaRealtime) {
		globalThis.__alethiaRealtime = new PgListenTransport<number>(
			"job_logs",
			routeJobLog,
		);
	}
	return globalThis.__alethiaRealtime;
}

/**
 * The process-wide support-message realtime transport (HMR/instance-safe singleton).
 * `subscribe(caseId, cb)` delivers the messageId of each new row inserted on that case;
 * the SSE route then fetches the row (visible messages only) and emits it.
 */
export function getSupportMessageTransport(): ChannelTransport<string> {
	if (!globalThis.__alethiaSupport) {
		globalThis.__alethiaSupport = new PgListenTransport<string>(
			"support_messages",
			routeSupportMessage,
		);
	}
	return globalThis.__alethiaSupport;
}

/**
 * The process-wide runner-cancel transport (HMR/instance-safe singleton).
 * `subscribe(runnerId, cb)` delivers the jobId of each job the console wants that runner
 * to cancel mid-flight. Emitted by notifyRunnerCancel (pg_notify 'runner_cancel'); the
 * runner's wake SSE route forwards it as a typed cancel event to that runner only.
 */
export function getCancelTransport(): ChannelTransport<string> {
	if (!globalThis.__alethiaCancel) {
		globalThis.__alethiaCancel = new PgListenTransport<string>(
			"runner_cancel",
			routeRunnerCancel,
		);
	}
	return globalThis.__alethiaCancel;
}

// ── The console's change bus (#6115) ─────────────────────────────────────────

/** One notice on `alethia_change`: a row change, or the bus's own self-test echo. */
export type ChangeValue = ChangeNotice | SelfTestNotice;

/** The `alethia_change` transport, as lib/realtime/bus.ts and self-test.ts use it. */
export interface ChangeTransport extends ChannelTransport<ChangeValue> {
	/** Hear every notice, whatever its keys. Returns the removal. */
	tap(cb: (value: ChangeValue) => void): () => void;
	/** Called after every LISTEN that follows the first. Returns the removal. */
	onReconnect(cb: () => void): () => void;
	/** True once LISTENing, false if not within `timeoutMs`. */
	whenListening(timeoutMs: number): Promise<boolean>;
	/** Close the connection and open a new one. */
	restart(): void;
	/** Close the connection (a later subscribe, tap or wait reopens it). */
	close(): void;
}

/** The channel the change triggers NOTIFY on (lib/db/programmables.sql `emit_change`). */
export const CHANGE_CHANNEL = "alethia_change";

/**
 * Where the change bus LISTENs: `ALETHIA_LISTEN_DATABASE_URL`, else the service URL.
 *
 * The override exists for ONE deployment shape: a Postgres reached through a TRANSACTION-mode
 * pooler (PgBouncer, Supavisor). LISTEN is session state, and a transaction pooler hands the session
 * to someone else after each statement, so the LISTEN silently stops hearing anything. Point this at
 * a direct (or session-mode) connection. Nothing in the bundled deploy uses a pooler; the self-test
 * (lib/realtime/self-test.ts) names this variable when it finds the LISTEN deaf.
 */
function listenDatabaseUrl(): string {
	return process.env.ALETHIA_LISTEN_DATABASE_URL || getDatabaseConfig().serviceUrl;
}

/** Parses an `alethia_change` notify into its keys (lib/realtime/routing.ts) and the notice itself. */
function routeChange(
	payload: unknown,
): { key: readonly string[]; value: ChangeValue } | null {
	const notice = parseNotice(payload);
	if (!notice) return null;
	if (notice.kind === "selftest") return { key: [], value: notice };
	return { key: keysFor(notice).map((r) => r.key), value: notice };
}

/**
 * The process-wide change transport (HMR/instance-safe singleton): ONE LISTEN connection on
 * `alethia_change` per process, whatever the number of streams. lib/realtime/bus.ts is its consumer.
 */
export function getChangeTransport(): ChangeTransport {
	if (!globalThis.__alethiaChange) {
		globalThis.__alethiaChange = new PgListenTransport<ChangeValue>(
			CHANGE_CHANNEL,
			routeChange,
			{ url: listenDatabaseUrl },
		);
	}
	return globalThis.__alethiaChange;
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
				rtlog.error("LISTEN failed", { channel: "runner_wake", err });
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
	if (!globalThis.__alethiaWake) {
		globalThis.__alethiaWake = new PgWakeTransport();
	}
	return globalThis.__alethiaWake;
}
