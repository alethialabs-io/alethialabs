// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6757: the one reader of a per-resource event stream. It says where the stream stands in exactly
// four states, tries a dropped stream again a bounded number of times and then reads `closed`, and
// composes with the session state: a 401 ends the session, and a session ended by any source stops
// the stream. The run loop is driven over a fake `fetch` whose bodies are real ReadableStreams, with
// waiting counted in event-loop turns (tests/lib/realtime/client/harness.ts), never in milliseconds.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EVENT_STREAM_RETRIES,
	EVENT_STREAM_STATES,
	type EventStreamMessage,
	type EventStreamState,
	runEventStream,
	useEventStream,
} from "@/hooks/use-event-stream";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";
import { until } from "../lib/realtime/client/harness";

const STREAM_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8" };
const URL_A = "/api/stream/jobs/job-a";
const URL_B = "/api/stream/jobs/job-b";

/** A stream response whose body the test writes to. */
function openBody() {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const enc = new TextEncoder();
	return {
		response: new Response(body, { status: 200, headers: STREAM_HEADERS }),
		write: (text: string) => controller?.enqueue(enc.encode(text)),
		close: () => controller?.close(),
	};
}

/** A stream response that sends `text` (nothing when empty) and ends at once. */
function finished(text: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			if (text !== "") c.enqueue(new TextEncoder().encode(text));
			c.close();
		},
	});
	return new Response(body, { status: 200, headers: STREAM_HEADERS });
}

/** One request the fake `fetch` saw. */
interface Call {
	url: string;
	lastEventId: string | null;
	signal: AbortSignal | null;
}

/** A fake `fetch` over scripted answers; once the script is spent, `spent` answers. */
function fakeFetch(script: Array<() => Response | Promise<Response>>, spent: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			lastEventId: new Headers(init?.headers).get("Last-Event-ID"),
			signal: init?.signal ?? null,
		});
		return (script.shift() ?? spent)();
	});
	return { impl, calls };
}

/** Runs the loop over scripted answers; when the script is spent the run is aborted. */
function harness(script: Array<() => Response | Promise<Response>>) {
	const states: EventStreamState[] = [];
	const messages: EventStreamMessage[] = [];
	const sleeps: number[] = [];
	const abort = new AbortController();
	const { impl, calls } = fakeFetch(script, () => {
		abort.abort();
		return new Response(null, { status: 503 });
	});
	const run = (lastEventId?: string) =>
		runEventStream({
			url: URL_A,
			signal: abort.signal,
			fetch: impl,
			random: () => 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			onState: (state) => states.push(state),
			onMessage: (message) => messages.push(message),
			...(lastEventId === undefined ? {} : { lastEventId }),
		});
	return { run, states, messages, sleeps, calls, abort };
}

/** A network failure, as `fetch` reports one. */
const fail = () => Promise.reject(new TypeError("network"));

describe("the four states", () => {
	it("are exactly connecting, open, closed and signed-out", () => {
		expect([...EVENT_STREAM_STATES]).toEqual(["connecting", "open", "closed", "signed-out"]);
	});
});

describe("runEventStream", () => {
	it("opens, and delivers each message with its event name and id", async () => {
		const s = openBody();
		const h = harness([() => s.response]);
		const run = h.run();
		s.write(":\n\nid: 1\ndata: first\n\nevent: done\nid: 2\ndata: second\n\n");
		await until(() => h.messages.length === 2, "both messages are delivered");
		expect(h.messages).toEqual([
			{ event: "message", data: "first", id: "1" },
			{ event: "done", data: "second", id: "2" },
		]);
		expect(h.states).toEqual(["connecting", "open"]);
		h.abort.abort();
		await run;
	});

	it("a stream that drops is opened again after the last id it saw", async () => {
		const first = openBody();
		const second = openBody();
		const h = harness([() => first.response, () => second.response]);
		const run = h.run();
		first.write("id: 7\ndata: a\n\n");
		await until(() => h.messages.length === 1, "the first stream delivers");
		first.close();
		second.write("id: 8\ndata: b\n\n");
		await until(() => h.messages.length === 2, "the second stream delivers");
		expect(h.calls.map((c) => c.lastEventId)).toEqual([null, "7"]);
		expect(h.sleeps).toEqual([1000]);
		expect(h.states).toEqual(["connecting", "open", "connecting", "open"]);
		h.abort.abort();
		await run;
	});

	it("the first request carries the id the caller already holds", async () => {
		const s = openBody();
		const h = harness([() => s.response]);
		const run = h.run("41");
		await until(() => h.states.includes("open"), "the stream opens");
		expect(h.calls.map((c) => c.lastEventId)).toEqual(["41"]);
		h.abort.abort();
		await run;
	});

	it("401 is signed-out at once: no second request", async () => {
		const h = harness([() => new Response("Unauthorized", { status: 401 })]);
		await h.run();
		expect(h.states).toEqual(["connecting", "signed-out"]);
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	it.each([403, 404])("%i is closed at once: another attempt would get the same answer", async (status) => {
		const h = harness([() => new Response(null, { status })]);
		await h.run();
		expect(h.states).toEqual(["connecting", "closed"]);
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	it("attempts that deliver nothing back off, and after the last one it reads closed", async () => {
		const h = harness(Array.from({ length: EVENT_STREAM_RETRIES + 1 }, () => fail));
		await h.run();
		expect(h.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000]);
		expect(h.calls).toHaveLength(EVENT_STREAM_RETRIES + 1);
		expect(h.states.at(-1)).toBe("closed");
		expect(h.states.filter((s) => s === "closed")).toHaveLength(1);
	});

	it("a stream that opens and ends without a byte counts as a failed attempt", async () => {
		const h = harness(Array.from({ length: EVENT_STREAM_RETRIES + 1 }, () => () => finished("")));
		await h.run();
		expect(h.sleeps).toHaveLength(EVENT_STREAM_RETRIES);
		expect(h.states.at(-1)).toBe("closed");
	});

	it("a stream that delivered bytes starts the count of attempts again", async () => {
		const h = harness([fail, fail, () => finished("id: 3\ndata: x\n\n"), fail]);
		await h.run();
		expect(h.sleeps).toEqual([1000, 2000, 1000, 2000]);
		expect(h.states).not.toContain("closed");
	});

	it("a 200 that is not an event stream is a failed attempt, and 429 waits for Retry-After", async () => {
		const h = harness([
			() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
			() => new Response(null, { status: 429, headers: { "Retry-After": "7" } }),
		]);
		await h.run();
		expect(h.sleeps).toEqual([1000, 7000]);
		expect(h.messages).toEqual([]);
	});

	it("reports nothing after it is stopped", async () => {
		const s = openBody();
		const h = harness([() => s.response]);
		const run = h.run();
		await until(() => h.states.includes("open"), "the stream opens");
		h.abort.abort();
		await run;
		expect(h.states).toEqual(["connecting", "open"]);
		expect(h.calls).toHaveLength(1);
	});
});

describe("useEventStream", () => {
	beforeEach(() => {
		useSessionState.setState({ status: "active", dismissed: false });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Stubs the global `fetch` with scripted answers; a spent script answers 404. */
	function stubFetch(script: Array<() => Response | Promise<Response>>) {
		const fake = fakeFetch(script, () => new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fake.impl);
		return fake;
	}

	it("with no address there is no stream: no request, and no state to show", () => {
		const { calls } = stubFetch([]);
		const { result } = renderHook(() => useEventStream(null));
		expect(result.current.state).toBeNull();
		expect(calls).toEqual([]);
	});

	it("reads connecting, then open, and hands each message to the latest onMessage", async () => {
		const s = openBody();
		const { calls } = stubFetch([() => s.response]);
		const first = vi.fn();
		const second = vi.fn();
		const { result, rerender } = renderHook(({ onMessage }) => useEventStream(URL_A, { onMessage }), {
			initialProps: { onMessage: first },
		});
		expect(result.current.state).toBe("connecting");
		await waitFor(() => expect(result.current.state).toBe("open"));

		s.write("id: 1\ndata: one\n\n");
		await waitFor(() => expect(first).toHaveBeenCalledWith({ event: "message", data: "one", id: "1" }));
		rerender({ onMessage: second });
		s.write("id: 2\ndata: two\n\n");
		await waitFor(() => expect(second).toHaveBeenCalledWith({ event: "message", data: "two", id: "2" }));
		expect(first).toHaveBeenCalledTimes(1);
		// A new onMessage is not a reason to open the stream again.
		expect(calls).toHaveLength(1);
	});

	it("a 401 reads signed-out and ends the session state", async () => {
		stubFetch([() => new Response("Unauthorized", { status: 401 })]);
		const { result } = renderHook(() => useEventStream(URL_A));
		await waitFor(() => expect(result.current.state).toBe("signed-out"));
		expect(useSessionState.getState().status).toBe("ended");
	});

	it("a session ended by another source stops the stream and reads signed-out", async () => {
		const s = openBody();
		const { calls } = stubFetch([() => s.response]);
		const { result } = renderHook(() => useEventStream(URL_A));
		await waitFor(() => expect(result.current.state).toBe("open"));

		act(() => endSession());
		expect(result.current.state).toBe("signed-out");
		expect(calls[0]?.signal?.aborted).toBe(true);
		// Reconnect asks for nothing while the session is ended.
		act(() => result.current.reconnect());
		expect(calls).toHaveLength(1);
		expect(result.current.state).toBe("signed-out");
	});

	it("opens nothing when the session has already ended", () => {
		endSession();
		const { calls } = stubFetch([]);
		const { result } = renderHook(() => useEventStream(URL_A));
		expect(result.current.state).toBe("signed-out");
		expect(calls).toEqual([]);
	});

	it("closed stays closed until reconnect, which opens the stream again", async () => {
		const s = openBody();
		const { calls } = stubFetch([() => new Response(null, { status: 404 }), () => s.response]);
		const { result } = renderHook(() => useEventStream(URL_A));
		await waitFor(() => expect(result.current.state).toBe("closed"));
		expect(calls).toHaveLength(1);
		expect(useSessionState.getState().status).toBe("active");

		act(() => result.current.reconnect());
		await waitFor(() => expect(result.current.state).toBe("open"));
		expect(calls).toHaveLength(2);
	});

	it("reconnect resumes after the last message id seen on that address", async () => {
		const first = openBody();
		const second = openBody();
		const { calls } = stubFetch([() => first.response, () => second.response]);
		const onMessage = vi.fn();
		const { result } = renderHook(() => useEventStream(URL_A, { onMessage }));
		await waitFor(() => expect(result.current.state).toBe("open"));
		first.write("id: 9\ndata: nine\n\n");
		await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));

		act(() => result.current.reconnect());
		await waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[0]?.signal?.aborted).toBe(true);
		expect(calls.map((c) => c.lastEventId)).toEqual([null, "9"]);
	});

	it("a new address closes the old stream and starts from connecting, without the old address's id", async () => {
		const first = openBody();
		const second = openBody();
		const { calls } = stubFetch([() => first.response, () => second.response]);
		const onMessage = vi.fn();
		const { result, rerender } = renderHook(({ url }: { url: string }) => useEventStream(url, { onMessage }), {
			initialProps: { url: URL_A },
		});
		await waitFor(() => expect(result.current.state).toBe("open"));
		first.write("id: 5\ndata: five\n\n");
		await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));

		rerender({ url: URL_B });
		expect(result.current.state).toBe("connecting");
		await waitFor(() => expect(result.current.state).toBe("open"));
		expect(calls.map((c) => [c.url, c.lastEventId])).toEqual([
			[URL_A, null],
			[URL_B, null],
		]);
		expect(calls[0]?.signal?.aborted).toBe(true);
	});

	it("an address that becomes null (the resource finished) closes the stream and shows no state", async () => {
		const s = openBody();
		const { calls } = stubFetch([() => s.response]);
		const initialProps: { url: string | null } = { url: URL_A };
		const { result, rerender } = renderHook(({ url }: { url: string | null }) => useEventStream(url), {
			initialProps,
		});
		await waitFor(() => expect(result.current.state).toBe("open"));
		rerender({ url: null });
		expect(result.current.state).toBeNull();
		expect(calls[0]?.signal?.aborted).toBe(true);
		expect(calls).toHaveLength(1);
	});
});
