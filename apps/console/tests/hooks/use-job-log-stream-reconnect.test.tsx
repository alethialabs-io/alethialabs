// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6818 — the job log over the REAL reader (`useEventStream`), with only `fetch` faked: a stream
// that drops mid-job is opened again by itself, resumes after the last line it delivered, and the
// log on screen has every line exactly once. tests/hooks/use-job-log-stream.test.tsx pins which
// stream the hook asks for over a stand-in reader; this file is the two halves together.
//
// The one wait is the reader's first backoff, which is a real second (`backoffMs(0)` with the
// jitter pinned to zero). It is waited for, not faked: the retry is the thing under test.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_LOG_END_EVENT } from "@/components/jobs/job-log-contract";
import { type JobLogEntry, useJobLogStream } from "@/hooks/use-job-log-stream";
import { useSessionState } from "@/lib/stores/use-session-state";

const STREAM_HEADERS = { "Content-Type": "text/event-stream" };

const line = (id: number): JobLogEntry => ({
	id,
	log_chunk: `line ${id}`,
	stream_type: "STDOUT",
	created_at: "2026-10-20T10:00:00.000Z",
});

/** One log line as the route frames it. */
const frame = (entry: JobLogEntry): string => `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;

/** A stream response whose body the test writes to and ends. */
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

/** One request the fake `fetch` saw. */
interface Call {
	url: string;
	lastEventId: string | null;
}

/** Stubs the global `fetch` with scripted answers; a spent script answers 404. */
function stubFetch(script: Array<() => Response>) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), lastEventId: new Headers(init?.headers).get("Last-Event-ID") });
			return (script.shift() ?? (() => new Response(null, { status: 404 })))();
		}),
	);
	return calls;
}

beforeEach(() => {
	useSessionState.setState({ status: "active", dismissed: false });
	vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("a job log whose stream drops", () => {
	it("reconnects by itself, resumes after the last line it had, and shows every line once", async () => {
		const first = openBody();
		const second = openBody();
		const calls = stubFetch([() => first.response, () => second.response]);
		const head = { lines: [line(1), line(2)], lastId: 2 };
		const { result } = renderHook(() => useJobLogStream("job-1", head, true));

		await waitFor(() => expect(result.current.state).toBe("open"));
		expect(calls).toEqual([{ url: "/api/stream/jobs/job-1?after=2", lastEventId: null }]);
		first.write(frame(line(3)) + frame(line(4)));
		await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3, 4]));

		// The connection drops mid-job.
		first.close();
		await waitFor(() => expect(result.current.state).toBe("connecting"));
		// It is opened again without anyone asking, after the last line DELIVERED — not after the head.
		await waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
		expect(calls[1]).toEqual({ url: "/api/stream/jobs/job-1?after=2", lastEventId: "4" });
		await waitFor(() => expect(result.current.state).toBe("open"));

		// A server that resent a line the reader already has must not put it on screen twice, and
		// the lines written while the stream was down must all arrive.
		second.write(frame(line(4)) + frame(line(5)) + frame(line(6)));
		await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3, 4, 5, 6]));
		expect(result.current.logs.map((l) => l.log_chunk)).toEqual([
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
		]);
	}, 15_000);

	it("stops for good at the end event: no further request, and no state to show", async () => {
		const body = openBody();
		const calls = stubFetch([() => body.response]);
		const { result } = renderHook(() => useJobLogStream("job-1", { lines: [line(1)], lastId: 1 }, true));
		await waitFor(() => expect(result.current.state).toBe("open"));

		body.write(`${frame(line(2))}event: ${JOB_LOG_END_EVENT}\ndata: {}\n\n`);
		body.close();
		await waitFor(() => expect(result.current.complete).toBe(true));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
		expect(result.current.state).toBeNull();
		// Longer than the reader's first backoff: a stream that ended is not retried.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(calls).toHaveLength(1);
	}, 15_000);

	it("a stream the server refuses reads closed, and reconnect asks again from the last line held", async () => {
		const body = openBody();
		const calls = stubFetch([() => new Response(null, { status: 404 }), () => body.response]);
		const { result } = renderHook(() => useJobLogStream("job-1", { lines: [line(1)], lastId: 1 }, true));
		await waitFor(() => expect(result.current.state).toBe("closed"));
		expect(calls).toHaveLength(1);

		act(() => result.current.reconnect());
		await waitFor(() => expect(result.current.state).toBe("open"));
		expect(calls[1]?.url).toBe("/api/stream/jobs/job-1?after=1");
		body.write(frame(line(2)));
		await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]));
	}, 15_000);
});
