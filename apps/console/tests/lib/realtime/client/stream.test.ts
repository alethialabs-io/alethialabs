// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B: the browser half of `/{org}/~/events`. The parser is driven with the exact bytes the
// server's frame builders write (lib/realtime/sse.ts), split at awkward places, so a change to either
// side that breaks the other shows here. The run loop is driven over a fake `fetch` whose bodies are
// real ReadableStreams.

import { describe, expect, it, vi } from "vitest";
import { settle, until } from "./harness";

vi.mock("server-only", () => ({}));

import {
	backoffMs,
	classifyStatus,
	helloNeedsResync,
	probeUrl,
	readServerEvent,
	retryAfterMs,
	runStream,
	SseParser,
	type StreamOptions,
} from "@/lib/realtime/client/stream";
import type { ConnectionState } from "@/lib/realtime/client/connection-state";
import {
	HEARTBEAT_FRAME,
	helloFrame,
	hintFrame,
	resyncFrame,
	retryFrame,
	revokedFrame,
} from "@/lib/realtime/sse";
import type { Hint } from "@/lib/realtime/topics";

const JOB = "6f1c1d1e-0000-4000-8000-000000000001";

/** Parses a whole wire text, chunk by chunk. */
function parseAll(chunks: string[]) {
	const parser = new SseParser();
	const events = [];
	let retry: number | undefined;
	for (const chunk of chunks) {
		const out = parser.push(chunk);
		events.push(...out.events);
		if (out.retry !== undefined) retry = out.retry;
	}
	return { events, retry };
}

describe("SseParser over the server's own frames", () => {
	const wire =
		retryFrame(4321) +
		helloFrame("boot-1", "tag.0") +
		HEARTBEAT_FRAME +
		hintFrame({ t: "jobs", id: JOB }, "tag.1") +
		resyncFrame("backpressure", "tag.2") +
		revokedFrame("not-member");

	it("reads retry, hello, hint, resync and revoked, and skips the heartbeat", () => {
		const { events, retry } = parseAll([wire]);
		expect(retry).toBe(4321);
		expect(events.map((e) => readServerEvent(e))).toEqual([
			{ type: "hello", v: 1, boot: "boot-1", cursor: "tag.0" },
			{ type: "hint", cursor: "tag.1", hint: { t: "jobs", id: JOB } },
			{ type: "resync", cursor: "tag.2", reason: "backpressure" },
			{ type: "revoked", reason: "not-member" },
		]);
	});

	it("gives the same events whatever the chunking, CRLF line ends included", () => {
		const whole = parseAll([wire]).events;
		const crlf = wire.replace(/\n/g, "\r\n");
		for (const text of [wire, crlf]) {
			for (const size of [1, 2, 3, 7, 13]) {
				const chunks: string[] = [];
				for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
				expect(parseAll(chunks).events).toEqual(whole);
			}
		}
	});

	it("joins multi-line data and dispatches nothing for an event with no data", () => {
		expect(parseAll(["event: x\ndata: a\ndata: b\n\nevent: y\n\n"]).events).toEqual([
			{ event: "x", data: "a\nb" },
		]);
	});
});

describe("readServerEvent", () => {
	it("drops a topic this bundle does not know, so a newer server cannot wedge an old tab", () => {
		expect(readServerEvent({ event: "hint", id: "t.1", data: '{"t":"telepathy"}' })).toBeNull();
	});

	it("drops a hint without a cursor, malformed JSON and unknown events", () => {
		expect(readServerEvent({ event: "hint", data: '{"t":"jobs"}' })).toBeNull();
		expect(readServerEvent({ event: "hint", id: "t.1", data: "{" })).toBeNull();
		expect(readServerEvent({ event: "gossip", data: "{}" })).toBeNull();
		expect(readServerEvent({ event: "revoked", data: '{"reason":"bored"}' })).toBeNull();
	});
});

describe("classifyStatus — what a refused stream or a probe means", () => {
	it.each([
		[204, { kind: "ok" }],
		[401, { kind: "signed-out" }],
		[403, { kind: "removed" }],
		[404, { kind: "removed" }],
		[500, { kind: "retry" }],
		[502, { kind: "retry" }],
	])("%i → %o", (status, verdict) => {
		expect(classifyStatus(status, null)).toEqual(verdict);
	});

	it("429 waits for Retry-After (seconds or a date), capped, with 30 s when absent", () => {
		expect(classifyStatus(429, "12")).toEqual({ kind: "wait", ms: 12_000 });
		expect(classifyStatus(429, null)).toEqual({ kind: "wait", ms: 30_000 });
		expect(classifyStatus(429, "999999")).toEqual({ kind: "wait", ms: 300_000 });
		const now = Date.parse("2026-10-20T10:00:00Z");
		expect(retryAfterMs("Tue, 20 Oct 2026 10:00:05 GMT", now)).toBe(5000);
		expect(retryAfterMs("soon", now)).toBeNull();
	});
});

describe("backoff and resync decisions", () => {
	it("backs off 1 s·2ⁿ up to 30 s, plus under 1 s of jitter", () => {
		expect(backoffMs(0, () => 0)).toBe(1000);
		expect(backoffMs(3, () => 0)).toBe(8000);
		expect(backoffMs(10, () => 0)).toBe(30_000);
		expect(backoffMs(10, () => 0.999)).toBe(30_999);
	});

	it("resyncs on a changed boot or cursor, never on the browser's first stream", () => {
		const at = { boot: "b1", cursor: "x.4" };
		expect(helloNeedsResync(undefined, at)).toBe(false);
		expect(helloNeedsResync(at, { boot: "b1", cursor: "x.4" })).toBe(false);
		expect(helloNeedsResync(at, { boot: "b1", cursor: "y.0" })).toBe(true);
		expect(helloNeedsResync(at, { boot: "b2", cursor: "x.4" })).toBe(true);
	});

	it("builds the probe URL", () => {
		expect(probeUrl("/acme/~/events")).toBe("/acme/~/events?probe=1");
	});
});

// ── The run loop ───────────────────────────────────────────────────────────────

/** A stream response whose body we write to. */
function openBody() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const enc = new TextEncoder();
	return {
		response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
		write: (text: string) => controller.enqueue(enc.encode(text)),
		close: () => controller.close(),
	};
}

/** Runs a stream over scripted responses; `probe` answers every `?probe=1`. */
function harness(script: Array<() => Response | Promise<Response>>, probe: () => Response) {
	const states: ConnectionState[] = [];
	const hints: Hint[] = [];
	let resyncs = 0;
	const calls: string[] = [];
	const sleeps: number[] = [];
	const abort = new AbortController();
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("probe=1")) return probe();
		const next = script.shift();
		if (!next) {
			abort.abort();
			return new Response(null, { status: 503 });
		}
		return next();
	});
	const options: StreamOptions = {
		url: "/acme/~/events",
		signal: abort.signal,
		fetch: fetchImpl,
		random: () => 0,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		onState: (s) => states.push(s),
		onHint: (h) => hints.push(h),
		onResync: () => {
			resyncs += 1;
		},
		onPosition: () => {},
	};
	return { options, states, hints, calls, sleeps, abort, resyncs: () => resyncs };
}

describe("runStream", () => {
	it("goes live on hello, delivers hints, and does not resync the first stream", async () => {
		const s = openBody();
		const h = harness([() => s.response], () => new Response(null, { status: 204 }));
		const run = runStream(h.options);
		s.write(retryFrame(3000) + helloFrame("b1", "a.0") + hintFrame({ t: "jobs", id: JOB }, "a.1"));
		await until(() => h.hints.length === 1, "the hint is delivered");
		expect(h.hints).toEqual([{ t: "jobs", id: JOB }]);
		expect(h.states).toEqual(["connecting", "live"]);
		expect(h.resyncs()).toBe(0);
		h.abort.abort();
		await run;
	});

	it("a plain close probes, waits the server's retry, reconnects and RESYNCS (a new stream's cursor never matches)", async () => {
		const first = openBody();
		const second = openBody();
		const h = harness([() => first.response, () => second.response], () => new Response(null, { status: 204 }));
		const run = runStream(h.options);
		first.write(retryFrame(4000) + helloFrame("b1", "a.0"));
		first.close();
		second.write(helloFrame("b1", "b.0"));
		await until(() => h.resyncs() === 1, "the second stream's hello resyncs");
		expect(h.calls).toEqual(["/acme/~/events", "/acme/~/events?probe=1", "/acme/~/events"]);
		expect(h.sleeps).toEqual([4000]);
		expect(h.states).toEqual(["connecting", "live", "reconnecting", "live"]);
		h.abort.abort();
		await run;
	});

	it("`revoked` is terminal: no probe, no reconnect", async () => {
		const s = openBody();
		const h = harness([() => s.response], () => new Response(null, { status: 204 }));
		const run = runStream(h.options);
		s.write(helloFrame("b1", "a.0") + revokedFrame("unauthorized"));
		await run;
		expect(h.states.at(-1)).toBe("signed-out");
		expect(h.calls).toEqual(["/acme/~/events"]);
	});

	it.each([
		["not-member", "removed"],
		["terms", "removed"],
	] as const)("revoked %s → %s", async (reason, state) => {
		const s = openBody();
		const h = harness([() => s.response], () => new Response(null, { status: 204 }));
		const run = runStream(h.options);
		s.write(helloFrame("b1", "a.0") + revokedFrame(reason));
		await run;
		expect(h.states.at(-1)).toBe(state);
	});

	it("a closed stream whose probe says 401 stops as signed-out instead of spinning", async () => {
		const s = openBody();
		const h = harness([() => s.response], () => new Response(null, { status: 401 }));
		const run = runStream(h.options);
		s.write(helloFrame("b1", "a.0"));
		s.close();
		await run;
		expect(h.states.at(-1)).toBe("signed-out");
		expect(h.calls).toEqual(["/acme/~/events", "/acme/~/events?probe=1"]);
	});

	it("a refused stream is classified from its own status: 404 → removed", async () => {
		const h = harness([() => new Response(null, { status: 404 })], () => new Response(null, { status: 204 }));
		await runStream(h.options);
		expect(h.states).toEqual(["connecting", "removed"]);
	});

	it("429 waits Retry-After (+ jitter) and reads as degraded", async () => {
		const h = harness(
			[() => new Response(null, { status: 429, headers: { "Retry-After": "7" } })],
			() => new Response(null, { status: 204 }),
		);
		await runStream({ ...h.options, random: () => 0.5 });
		expect(h.sleeps[0]).toBe(7000 + 500);
		expect(h.states).toContain("degraded");
	});

	it("a 200 that is not an event stream (a sign-in page) asks the probe", async () => {
		const h = harness(
			[() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
			() => new Response(null, { status: 401 }),
		);
		await runStream(h.options);
		expect(h.states.at(-1)).toBe("signed-out");
	});

	it("network failures back off exponentially and turn degraded after three", async () => {
		const fail = () => Promise.reject(new TypeError("network"));
		const h = harness([fail, fail, fail], () => new Response(null, { status: 204 }));
		await runStream(h.options);
		expect(h.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
		expect(h.states.slice(0, 4)).toEqual(["connecting", "connecting", "connecting", "degraded"]);
	});

	it("heartbeats keep a stream alive; silence past the stall window drops and reopens it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const first = openBody();
			const second = openBody();
			const h = harness([() => first.response, () => second.response], () => new Response(null, { status: 204 }));
			const run = runStream({ ...h.options, stallMs: 300 });
			first.write(helloFrame("b1", "a.0"));
			await until(() => h.states.includes("live"), "the first stream is live");
			// 400 ms of heartbeats every 50 ms (window 300 ms): each re-arms it, so the stream is NOT dropped.
			for (let i = 0; i < 8; i++) {
				await vi.advanceTimersByTimeAsync(50);
				first.write(HEARTBEAT_FRAME);
				await settle(); // the chunk is read and re-arms the window
			}
			expect(h.calls).toEqual(["/acme/~/events"]);
			// Then silence: dropped at exactly 300 ms after the last heartbeat, not before.
			second.write(helloFrame("b1", "b.0"));
			await vi.advanceTimersByTimeAsync(299);
			await settle();
			expect(h.calls).toEqual(["/acme/~/events"]);
			await vi.advanceTimersByTimeAsync(1);
			await until(() => h.resyncs() === 1, "the stalled stream is reopened and resyncs");
			h.abort.abort();
			await run;
		} finally {
			vi.useRealTimers();
		}
	});
});
