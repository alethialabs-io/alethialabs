// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The console's one reader of a PER-RESOURCE event stream: a job's log, an agent turn, anything a
// route sends as `text/event-stream` about one resource. The org's change stream is not this — it
// has its own client (`lib/realtime/client/stream.ts`), one per browser. The convention both follow
// is written down in `lib/realtime/README.md`.
//
// It reads over `fetch()` with the change stream's SSE parser, not `EventSource`. EventSource stops
// for good on any answer but 200 and never shows the status, so a session that ended, a resource
// that is gone and a server restart all look the same to it. Over fetch the status is read, and each
// of the three gets its own state.

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { backoffMs, classifyStatus, SseParser } from "@/lib/realtime/client/stream";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

/** Every state a stream can be in, in the order a healthy one passes through the first two. */
export const EVENT_STREAM_STATES = ["connecting", "open", "closed", "signed-out"] as const;

/**
 * Where a per-resource stream stands.
 *
 * - `connecting` — a request is out, or the next automatic attempt is scheduled.
 * - `open` — the server answered with an event stream; messages flow.
 * - `closed` — nothing more will arrive until {@link EventStream.reconnect} is called: the automatic
 *   attempts ran out, or the server refused the address (403, 404). The caller shows this.
 * - `signed-out` — the session is gone. The hook has reported it to the session state
 *   (`lib/stores/use-session-state.ts`), whose one surface shows it; the caller shows nothing.
 */
export type EventStreamState = (typeof EVENT_STREAM_STATES)[number];

/** One message off the stream: the SSE event name (`message` when unnamed), its data and its id. */
export interface EventStreamMessage {
	event: string;
	data: string;
	id?: string;
}

/** How many automatic attempts follow a stream that failed or dropped before it reads `closed`. */
export const EVENT_STREAM_RETRIES = 5;

/** No bytes for this long and the stream is taken for dead. Routes send a heartbeat every 20 s. */
const STALL_MS = 45_000;

/** Everything {@link runEventStream} needs; the injectables default to the browser's. */
export interface RunEventStreamOptions {
	url: string;
	signal: AbortSignal;
	onState(state: EventStreamState): void;
	onMessage(message: EventStreamMessage): void;
	/** The id of the last message already held, sent as `Last-Event-ID` on the first request. */
	lastEventId?: string;
	fetch?: typeof fetch;
	random?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	stallMs?: number;
}

/** Waits `ms`, or less if `signal` aborts first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		/** Ends the wait, whichever of the timer and the abort came first. */
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done);
	});
}

/**
 * Runs one per-resource stream until `signal` aborts or it reaches a state nothing follows
 * (`closed`, `signed-out`). Resolves when it stops; never rejects. Nothing is reported after the
 * abort.
 *
 * A stream that fails to open, or drops after it opened, is tried again with the change stream's
 * backoff, resuming after the last message id it saw (`Last-Event-ID`). After
 * {@link EVENT_STREAM_RETRIES} attempts in a row that delivered nothing it reads `closed`. A stream
 * that delivered bytes starts the count again, so a long-lived stream survives any number of
 * restarts spread over its life. 401 is `signed-out` and 403/404 is `closed`, both at once: another
 * attempt would get the same answer.
 */
export async function runEventStream(options: RunEventStreamOptions): Promise<void> {
	const doFetch = options.fetch ?? fetch;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? abortableSleep;
	const stallMs = options.stallMs ?? STALL_MS;
	const { signal } = options;

	let lastEventId = options.lastEventId;
	let failures = 0;

	/** Reports a state, unless the caller has already stopped the stream. */
	const report = (state: EventStreamState): void => {
		if (!signal.aborted) options.onState(state);
	};

	/** Reads one open stream to its end; true when it delivered any bytes at all. */
	const consume = async (body: ReadableStream<Uint8Array>): Promise<boolean> => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const parser = new SseParser();
		let received = false;
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		/** Drops the stream; a reader that is already done has nothing to cancel. */
		const drop = (): void => {
			void reader.cancel().catch(() => undefined);
		};
		/** Starts the silence window again. */
		const armStall = (): void => {
			clearTimeout(stallTimer);
			stallTimer = setTimeout(drop, stallMs);
		};
		signal.addEventListener("abort", drop);
		armStall();
		try {
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch {
					break;
				}
				if (chunk.done || signal.aborted) break;
				received = true;
				armStall();
				for (const message of parser.push(decoder.decode(chunk.value, { stream: true })).events) {
					if (message.id !== undefined) lastEventId = message.id;
					options.onMessage(message);
				}
			}
		} finally {
			clearTimeout(stallTimer);
			signal.removeEventListener("abort", drop);
		}
		return received;
	};

	report("connecting");
	while (!signal.aborted) {
		let waitMs = 0;
		let response: Response | null = null;
		try {
			response = await doFetch(options.url, {
				headers:
					lastEventId === undefined
						? { Accept: "text/event-stream" }
						: { Accept: "text/event-stream", "Last-Event-ID": lastEventId },
				cache: "no-store",
				credentials: "same-origin",
				signal,
			});
		} catch {
			// A network failure, or the abort: the loop's own check tells them apart.
		}
		if (signal.aborted) return;

		if (response !== null) {
			const verdict = classifyStatus(response.status, response.headers.get("Retry-After"));
			const isStream = (response.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
			if (verdict.kind === "ok" && response.body !== null && isStream) {
				report("open");
				const received = await consume(response.body);
				if (signal.aborted) return;
				if (received) failures = 0;
			} else {
				void response.body?.cancel().catch(() => undefined);
				if (verdict.kind === "signed-out") {
					report("signed-out");
					return;
				}
				if (verdict.kind === "removed") {
					report("closed");
					return;
				}
				if (verdict.kind === "wait") waitMs = verdict.ms;
			}
		}

		failures += 1;
		if (failures > EVENT_STREAM_RETRIES) {
			report("closed");
			return;
		}
		report("connecting");
		await sleep(Math.max(backoffMs(failures - 1, random), waitMs), signal);
	}
}

/** What {@link useEventStream} takes besides the address. */
export interface EventStreamOptions {
	/** Called with every message, in order. The latest function is used; changing it reopens nothing. */
	onMessage?: (message: EventStreamMessage) => void;
}

/** What {@link useEventStream} returns. */
export interface EventStream {
	/** The stream's state, or null when there is no stream because no address was given. */
	state: EventStreamState | null;
	/** Opens the stream again, resuming after the last message seen. For the `closed` state. */
	reconnect: () => void;
}

/**
 * Reads the event stream at `url` for as long as the component is mounted, and says where it stands
 * in one of four states ({@link EventStreamState}).
 *
 * Pass `null` for a resource that will send nothing more — a finished job, a turn that has ended.
 * No request is made and `state` is null: there is no stream to describe, so nothing reads
 * "disconnected" for a resource that simply ended.
 *
 * It composes with the session state rather than repeating it. A 401 from the stream calls
 * `endSession()`, and a session ended by ANY source stops the stream and reads `signed-out`, so a
 * stream is never retried into a refusal. The session-ended surface belongs to the shell; a caller
 * renders nothing for `signed-out`.
 */
export function useEventStream(url: string | null, options: EventStreamOptions = {}): EventStream {
	const sessionEnded = useSessionState((session) => session.status === "ended");
	// Counts the reconnects asked for. The state reported belongs to one address and one attempt
	// (`key`), so a new address or a reconnect starts from `connecting`, read off the key.
	const [attempt, setAttempt] = useState(0);
	const [reported, setReported] = useState<{ key: string; state: EventStreamState } | null>(null);
	// The last message id seen on an address, so a reconnect resumes there and not from the start.
	const resume = useRef<{ url: string; id: string } | null>(null);
	const key = url === null ? null : `${attempt}@${url}`;

	/** Hands a message to the caller's latest `onMessage`, without making it a reason to reopen. */
	const deliver = useEffectEvent((message: EventStreamMessage) => {
		options.onMessage?.(message);
	});

	useEffect(() => {
		if (url === null || key === null || sessionEnded) return;
		const address = url;
		const attemptKey = key;
		const held = resume.current;
		const controller = new AbortController();
		void runEventStream({
			url: address,
			signal: controller.signal,
			lastEventId: held !== null && held.url === address ? held.id : undefined,
			onState: (state) => {
				if (state === "signed-out") endSession();
				setReported({ key: attemptKey, state });
			},
			onMessage: (message) => {
				if (message.id !== undefined) resume.current = { url: address, id: message.id };
				deliver(message);
			},
		});
		return () => controller.abort();
	}, [url, key, sessionEnded]);

	/** Starts a new attempt: the effect closes the stream it holds and opens another. */
	const reconnect = useCallback(() => setAttempt((count) => count + 1), []);

	if (url === null) return { state: null, reconnect };
	if (sessionEnded) return { state: "signed-out", reconnect };
	return { state: reported !== null && reported.key === key ? reported.state : "connecting", reconnect };
}
