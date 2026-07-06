// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Realtime fan-out over Postgres LISTEN/NOTIFY for the admin app — the
// support-messages half of the console's lib/realtime (job_logs / runner_wake dropped;
// this app only streams case threads). A Postgres trigger does
// notify_support_message() → pg_notify('support_messages', {caseId, messageId}) on
// insert; this process holds ONE dedicated LISTEN connection and dispatches to its SSE
// subscribers keyed by caseId — so it scales across instances with no Redis.

import postgres from "postgres";
import { env } from "next-runtime-env";

/**
 * A per-channel realtime transport: subscribe a callback to a routing key (a caseId) and
 * receive the notify value dispatched only to that key.
 */
export interface ChannelTransport<TValue> {
	/** Subscribe to values for `key`. Returns an unsubscribe function. */
	subscribe(key: string, cb: (value: TValue) => void): () => void;
}

/** A parsed notify → the routing `key` and the `value` handed to that key's subscribers. */
type Route<TValue> = (payload: unknown) => { key: string; value: TValue } | null;

/**
 * Generic single-LISTEN-connection transport: one dedicated `max:1` Postgres LISTEN per
 * channel per app instance, keyed fan-out to subscribers, and lazy start with a
 * retry-on-failed-LISTEN reset. Parameterised by channel + a payload router.
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
		this.sql = postgres(env("ALETHIA_DATABASE_URL") ?? "", {
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
 * Parses a `support_messages` notify into {key: caseId, value: messageId}. Returns null
 * (ignored) for a malformed payload or one missing the two uuid string fields.
 */
function routeSupportMessage(
	payload: unknown,
): { key: string; value: string } | null {
	if (typeof payload !== "object" || payload === null) return null;
	if (!("caseId" in payload) || !("messageId" in payload)) return null;
	const caseId = payload.caseId;
	const messageId = payload.messageId;
	if (typeof caseId !== "string" || caseId.length === 0) return null;
	if (typeof messageId !== "string" || messageId.length === 0) return null;
	return { key: caseId, value: messageId };
}

const globalForRealtime = globalThis as unknown as {
	__supportAdminRealtime?: ChannelTransport<string>;
};

/**
 * The process-wide support-message realtime transport (HMR/instance-safe singleton).
 * `subscribe(caseId, cb)` delivers the messageId of each new row inserted on that case;
 * the SSE route then fetches the row and emits it.
 */
export function getSupportMessageTransport(): ChannelTransport<string> {
	if (!globalForRealtime.__supportAdminRealtime) {
		globalForRealtime.__supportAdminRealtime = new PgListenTransport<string>(
			"support_messages",
			routeSupportMessage,
		);
	}
	return globalForRealtime.__supportAdminRealtime;
}
