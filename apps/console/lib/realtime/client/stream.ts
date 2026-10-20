// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser half of `/{org}/~/events` (#6115, ADR 0005 D3 + §10 R7): one change stream read over
// `fetch()` with a small SSE parser, NOT `EventSource`. EventSource gives up on a non-200 without
// ever showing the status, so a signed-out tab and a server restart look identical to it; over
// fetch the status is visible, and a stream that closes is followed by `?probe=1`, which answers
// with the status a new stream would get.

import {
	type Hint,
	isTopic,
	type ResyncReason,
	type RevokedReason,
	type ServerEvent,
} from "@/lib/realtime/topics";
import type { ConnectionState } from "./connection-state";

/** One dispatched SSE event, before it is read as a {@link ServerEvent}. */
export interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

/** What the parser hands back for one chunk: the events it completed and any `retry:` it saw. */
export interface ParseResult {
	events: SseEvent[];
	retry?: number;
}

/**
 * An incremental SSE parser (the WHATWG event-stream format, reduced to what this server sends and
 * what a proxy may do to it): lines end in LF, CRLF or CR; a blank line dispatches; `:` lines are
 * comments (the heartbeat); `data:` lines join with LF; `retry:` takes digits only.
 */
export class SseParser {
	private buffer = "";
	private event = "";
	private data: string[] = [];
	private id: string | undefined;
	/** A CR that ended the last chunk: a LF opening the next one belongs to it. */
	private pendingCr = false;

	/** Feeds one decoded chunk and returns the events it completed. */
	push(chunk: string): ParseResult {
		let text = chunk;
		if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
		this.pendingCr = false;
		this.buffer += text;
		const result: ParseResult = { events: [] };
		for (;;) {
			const match = /\r\n|\n|\r/.exec(this.buffer);
			if (!match) break;
			// A CR at the very end may be the first half of a CRLF split across chunks.
			if (match[0] === "\r" && match.index === this.buffer.length - 1) {
				this.pendingCr = true;
			}
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			this.line(line, result);
		}
		return result;
	}

	/** Applies one complete line. */
	private line(line: string, result: ParseResult): void {
		if (line === "") {
			if (this.data.length > 0) {
				result.events.push({
					event: this.event || "message",
					data: this.data.join("\n"),
					...(this.id === undefined ? {} : { id: this.id }),
				});
			}
			this.event = "";
			this.data = [];
			this.id = undefined;
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		else if (field === "id") this.id = value;
		else if (field === "retry" && /^\d+$/.test(value)) result.retry = Number(value);
	}
}

/** A parsed JSON object, or null. */
function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: null;
	} catch {
		return null;
	}
}

const RESYNC_REASONS: readonly ResyncReason[] = ["reconnect", "backpressure", "keys-changed"];
const REVOKED_REASONS: readonly RevokedReason[] = ["unauthorized", "not-member", "terms"];

/**
 * Reads one SSE event as a {@link ServerEvent}, or null when it is not one this client understands
 * (an unknown event name, a topic newer than this bundle, a malformed body). An unknown event is
 * ignored rather than fatal, so a server deployed ahead of an open tab cannot wedge it.
 */
export function readServerEvent(e: SseEvent): ServerEvent | null {
	const body = jsonObject(e.data);
	if (!body) return null;
	switch (e.event) {
		case "hello": {
			const { v, boot, cursor } = body;
			if (v !== 1 || typeof boot !== "string" || typeof cursor !== "string") return null;
			return { type: "hello", v, boot, cursor };
		}
		case "hint": {
			const { t, id } = body;
			if (typeof t !== "string" || !isTopic(t) || e.id === undefined) return null;
			if (id !== undefined && typeof id !== "string") return null;
			const hint: Hint = id === undefined ? { t } : { t, id };
			return { type: "hint", cursor: e.id, hint };
		}
		case "resync": {
			const reason = RESYNC_REASONS.find((r) => r === body.reason);
			if (!reason || e.id === undefined) return null;
			return { type: "resync", cursor: e.id, reason };
		}
		case "revoked": {
			const reason = REVOKED_REASONS.find((r) => r === body.reason);
			return reason ? { type: "revoked", reason } : null;
		}
		default:
			return null;
	}
}

/** What a refused stream (or a probe) tells the client to do next. */
export type Verdict =
	| { kind: "ok" }
	| { kind: "signed-out" }
	| { kind: "removed" }
	| { kind: "wait"; ms: number }
	| { kind: "retry" };

/** The longest Retry-After this client will honour, so a bad header cannot park a tab for a day. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** `Retry-After` in ms: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
	if (header === null) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

/**
 * Classifies a status from the events route — a stream's own response, or a probe's.
 * 401 → signed out; 403/404 → this address is not ours (not a member, unknown org, Terms);
 * 429 → the per-person stream cap, wait for Retry-After; 2xx → fine; anything else (a 5xx, a proxy's
 * 502 during a deploy) → retry with backoff.
 */
export function classifyStatus(status: number, retryAfter: string | null, now?: number): Verdict {
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 401) return { kind: "signed-out" };
	if (status === 403 || status === 404) return { kind: "removed" };
	if (status === 429) return { kind: "wait", ms: retryAfterMs(retryAfter, now) ?? 30_000 };
	return { kind: "retry" };
}

/** Reconnect backoff after `failures` failed attempts in a row: min(30 s, 1 s·2ⁿ) + up to 1 s. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
	return Math.min(30_000, 1000 * 2 ** failures) + Math.floor(random() * 1000);
}

/** The probe URL for a stream URL. */
export function probeUrl(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}probe=1`;
}

/** Where a stream got to: the server process's boot id and the stream's last cursor. */
export interface StreamPosition {
	boot: string;
	cursor: string;
}

/**
 * Whether a `hello` means "you may have missed something". Nothing to compare on the first stream
 * this browser opened for the org; otherwise a different boot (deploy, restart, another replica) or
 * a different cursor (the server's cursors are per stream, so a NEW stream never matches) does.
 */
export function helloNeedsResync(prior: StreamPosition | undefined, hello: StreamPosition): boolean {
	if (!prior) return false;
	return prior.boot !== hello.boot || prior.cursor !== hello.cursor;
}

/** The callbacks a running stream reports through. */
interface StreamHandlers {
	onState(state: ConnectionState): void;
	onHint(hint: Hint): void;
	onResync(): void;
	onPosition(position: StreamPosition): void;
}

/** Everything {@link runStream} needs; the injectables default to the browser's. */
export interface StreamOptions extends StreamHandlers {
	url: string;
	signal: AbortSignal;
	/** The position the browser last reached on this org (from a previous leader tab), if any. */
	initial?: StreamPosition;
	fetch?: typeof fetch;
	random?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** No bytes for this long (heartbeats come every 20 s) and the stream is taken for dead. */
	stallMs?: number;
}

/** Waits `ms`, or less if `signal` aborts first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done);
	});
}

/** How a stream that was opened came to an end. */
type Ending =
	| { kind: "closed"; wasLive: boolean }
	| { kind: "revoked"; reason: RevokedReason }
	| { kind: "aborted" };

/** Consecutive failures after which the state reads `degraded` rather than `reconnecting`. */
const DEGRADED_AFTER = 3;

/**
 * Runs the stream until `signal` aborts or the server ends it for good. Reconnects on a plain close
 * (the server's re-check failed or timed out, a deploy, a proxy cut) after asking `?probe=1` why; a
 * `revoked` event is terminal and is never reconnected (the server sends it only when the session,
 * the membership or the Terms are gone). Resolves when it stops; never rejects.
 */
export async function runStream(options: StreamOptions): Promise<void> {
	const doFetch = options.fetch ?? fetch;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? abortableSleep;
	const stallMs = options.stallMs ?? 45_000;
	const { signal } = options;

	let position = options.initial;
	let retryMs: number | undefined;
	let failures = 0;
	let everLive = false;

	/** Applies a verdict; returns false when the stream must stop. */
	const settle = async (verdict: Verdict): Promise<boolean> => {
		switch (verdict.kind) {
			case "signed-out":
				options.onState("signed-out");
				return false;
			case "removed":
				options.onState("removed");
				return false;
			case "wait":
				options.onState("degraded");
				await sleep(verdict.ms + Math.floor(random() * 1000), signal);
				return true;
			case "ok":
			case "retry": {
				failures += 1;
				options.onState(failures >= DEGRADED_AFTER ? "degraded" : everLive ? "reconnecting" : "connecting");
				const base = backoffMs(failures - 1, random);
				await sleep(Math.max(base, failures === 1 ? (retryMs ?? 0) : 0), signal);
				return true;
			}
		}
	};

	/** Asks the probe why a stream ended; a probe that cannot be reached reads as "retry". */
	const askProbe = async (): Promise<Verdict> => {
		try {
			const res = await doFetch(probeUrl(options.url), {
				cache: "no-store",
				credentials: "same-origin",
				signal,
			});
			return classifyStatus(res.status, res.headers.get("Retry-After"));
		} catch {
			return { kind: "retry" };
		}
	};

	/** Reads one open stream to its end. */
	const consume = async (body: ReadableStream<Uint8Array>): Promise<Ending> => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const parser = new SseParser();
		let live = false;
		let stalled = false;
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const armStall = () => {
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => {
				stalled = true;
				void reader.cancel().catch(() => {});
			}, stallMs);
		};
		const onAbort = () => void reader.cancel().catch(() => {});
		signal.addEventListener("abort", onAbort);
		armStall();
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					break;
				}
				if (chunk.done) break;
				armStall();
				const parsed = parser.push(decoder.decode(chunk.value, { stream: true }));
				if (parsed.retry !== undefined) retryMs = parsed.retry;
				for (const raw of parsed.events) {
					const event = readServerEvent(raw);
					if (!event) continue;
					if (event.type === "revoked") return { kind: "revoked", reason: event.reason };
					if (event.type === "hello") {
						const hello = { boot: event.boot, cursor: event.cursor };
						const resync = helloNeedsResync(position, hello);
						position = hello;
						options.onPosition(hello);
						live = true;
						everLive = true;
						failures = 0;
						options.onState("live");
						if (resync) options.onResync();
						continue;
					}
					if (!live || !position) continue; // nothing counts before hello
					position = { boot: position.boot, cursor: event.cursor };
					options.onPosition(position);
					if (event.type === "hint") options.onHint(event.hint);
					else options.onResync();
				}
			}
		} finally {
			clearTimeout(stallTimer);
			signal.removeEventListener("abort", onAbort);
		}
		if (signal.aborted && !stalled) return { kind: "aborted" };
		return { kind: "closed", wasLive: live };
	};

	options.onState("connecting");
	while (!signal.aborted) {
		let res: Response;
		try {
			res = await doFetch(options.url, {
				headers: { Accept: "text/event-stream" },
				cache: "no-store",
				credentials: "same-origin",
				signal,
			});
		} catch {
			if (signal.aborted) return;
			if (!(await settle({ kind: "retry" }))) return;
			continue;
		}
		const verdict = classifyStatus(res.status, res.headers.get("Retry-After"));
		const isStream = (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
		if (verdict.kind !== "ok" || !res.body || !isStream) {
			void res.body?.cancel().catch(() => {});
			// A 2xx that is not a stream (a proxy's page, a redirect to sign-in) says nothing: ask.
			const next = verdict.kind === "ok" ? await askProbe() : verdict;
			if (signal.aborted) return;
			if (!(await settle(next.kind === "ok" ? { kind: "retry" } : next))) return;
			continue;
		}

		const ending = await consume(res.body);
		if (ending.kind === "aborted" || signal.aborted) return;
		if (ending.kind === "revoked") {
			options.onState(ending.reason === "unauthorized" ? "signed-out" : "removed");
			return;
		}
		// A plain close. Ask why before opening another stream: a session that ended between two
		// re-checks must stop here, not spin on 401s.
		if (ending.wasLive) options.onState("reconnecting");
		const probe = await askProbe();
		if (signal.aborted) return;
		if (probe.kind === "ok") {
			// The server would take us back: come back after its own jittered `retry:` (3–8 s), so a
			// deploy that dropped every stream at once does not get them all back in one second.
			if (ending.wasLive) {
				await sleep(retryMs ?? backoffMs(0, random), signal);
				continue;
			}
			if (!(await settle({ kind: "retry" }))) return;
			continue;
		}
		if (!(await settle(probe))) return;
	}
}
