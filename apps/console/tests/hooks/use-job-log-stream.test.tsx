// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The job log (#6121, #6818): the page paints the HEAD of the log from the server, then reads the
// tail from the job's event stream through `useEventStream`. What is pinned here is WHICH stream
// the hook asks for and when — after the head, once per job, none at all for a log that is already
// complete, one more request when the job finishes — and what it does with what arrives. The
// reader itself (states, retries, `Last-Event-ID`) is tests/hooks/use-event-stream.test.tsx; the two
// together, over a real dropped connection, are tests/hooks/use-job-log-stream-reconnect.test.tsx.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The stand-in reader: every address it was given, and the latest `onMessage`. */
const reader = vi.hoisted(() => ({
	addresses: [] as Array<string | null>,
	onMessage: undefined as undefined | ((message: { event: string; data: string; id?: string }) => void),
	state: "open" as "connecting" | "open" | "closed" | "signed-out",
	reconnect: () => {},
}));
vi.mock("@/hooks/use-event-stream", () => ({
	useEventStream: (
		url: string | null,
		options?: { onMessage?: (message: { event: string; data: string; id?: string }) => void },
	) => {
		if (reader.addresses.at(-1) !== url) reader.addresses.push(url);
		reader.onMessage = options?.onMessage;
		return { state: url === null ? null : reader.state, reconnect: reader.reconnect };
	},
}));

import { JOB_LOG_END_EVENT, jobLogStreamUrl } from "@/components/jobs/job-log-contract";
import {
	EMPTY_JOB_LOG_TAIL,
	type JobLogEntry,
	appendLogLine,
	mergeLogLines,
	useJobLogStream,
} from "@/hooks/use-job-log-stream";

const line = (id: number, chunk = `line ${id}`): JobLogEntry => ({
	id,
	log_chunk: chunk,
	stream_type: "STDOUT",
	created_at: "2026-10-20T10:00:00.000Z",
});

/** The streams the hook opened, in order: every address that was not "no stream". */
const opened = (): string[] => reader.addresses.filter((url): url is string => url !== null);

/** Delivers one log line as the stream would. */
const deliver = (entry: JobLogEntry): void =>
	act(() => reader.onMessage?.({ event: "message", data: JSON.stringify(entry), id: String(entry.id) }));

/** Delivers the end event: the job has finished and every line has been sent. */
const end = (): void => act(() => reader.onMessage?.({ event: JOB_LOG_END_EVENT, data: "{}" }));

beforeEach(() => {
	reader.addresses = [];
	reader.onMessage = undefined;
	reader.state = "open";
});

describe("mergeLogLines", () => {
	it("keeps each id once, in id order, head first", () => {
		expect(mergeLogLines([line(1), line(2)], [line(2, "dup"), line(3)]).map((l) => [l.id, l.log_chunk])).toEqual([
			[1, "line 1"],
			[2, "line 2"],
			[3, "line 3"],
		]);
	});

	it("is the stream alone when there is no head, and the head alone when the stream holds nothing past it", () => {
		expect(mergeLogLines([], [line(1), line(2)]).map((l) => l.id)).toEqual([1, 2]);
		expect(mergeLogLines([line(1), line(2)], [line(1), line(2)]).map((l) => l.id)).toEqual([1, 2]);
	});
});

describe("appendLogLine", () => {
	it("appends a new line and remembers its id", () => {
		const tail = appendLogLine(appendLogLine(EMPTY_JOB_LOG_TAIL, line(4)), line(5));
		expect(tail.blocks.flat().map((l) => l.id)).toEqual([4, 5]);
		expect(tail.lastId).toBe(5);
	});

	it("returns the SAME tail for a line it already holds, so a repeat re-renders nothing", () => {
		const tail = appendLogLine(appendLogLine(EMPTY_JOB_LOG_TAIL, line(4)), line(5));
		expect(appendLogLine(tail, line(5))).toBe(tail);
		expect(appendLogLine(tail, line(3))).toBe(tail);
	});

	it("starts a new block when one is full, leaving the full block untouched", () => {
		let tail = EMPTY_JOB_LOG_TAIL;
		for (let id = 1; id <= 500; id += 1) tail = appendLogLine(tail, line(id));
		const full = tail.blocks[0];
		tail = appendLogLine(tail, line(501));
		expect(tail.blocks).toHaveLength(2);
		expect(tail.blocks[0]).toBe(full);
		expect(tail.blocks.flat()).toHaveLength(501);
	});
});

describe("jobLogStreamUrl", () => {
	it("resumes after the head's last line, and sends the whole backlog from zero", () => {
		expect(jobLogStreamUrl("j", 42)).toBe("/api/stream/jobs/j?after=42");
		expect(jobLogStreamUrl("j", 0)).toBe("/api/stream/jobs/j");
	});

	it("the request for a finished job's remaining lines is a different address from the live one", () => {
		expect(jobLogStreamUrl("j", 42, true)).toBe("/api/stream/jobs/j?after=42&rest=1");
		expect(jobLogStreamUrl("j", 0, true)).toBe("/api/stream/jobs/j?rest=1");
	});
});

describe("useJobLogStream — a running job", () => {
	it("shows the head, then opens the stream after its last line and appends the tail", () => {
		const head = { lines: [line(1), line(2)], lastId: 2 };
		const { result } = renderHook(() => useJobLogStream("job-1", head, true));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
		expect(opened()).toEqual(["/api/stream/jobs/job-1?after=2"]);
		expect(result.current.state).toBe("open");
		expect(result.current.complete).toBe(false);

		deliver(line(3));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3]);
	});

	it("does not open the stream before the head has settled", () => {
		const { result } = renderHook(() => useJobLogStream("job-1", undefined, false));
		expect(opened()).toEqual([]);
		expect(result.current.state).toBeNull();
	});

	it("opens ONCE: a refetched head merges in without reconnecting", () => {
		const { rerender, result } = renderHook(({ head }) => useJobLogStream("job-1", head, true), {
			initialProps: { head: { lines: [line(1)], lastId: 1 } },
		});
		deliver(line(2));
		rerender({ head: { lines: [line(1), line(2)], lastId: 2 } });
		expect(opened()).toHaveLength(1);
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
	});

	it("a line delivered twice is held once", () => {
		const { result } = renderHook(() => useJobLogStream("job-1", { lines: [line(1)], lastId: 1 }, true));
		deliver(line(2));
		deliver(line(2));
		deliver(line(3));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3]);
	});

	it("ignores a message that is not a log line", () => {
		const { result } = renderHook(() => useJobLogStream("job-1", { lines: [line(1)], lastId: 1 }, true));
		act(() => reader.onMessage?.({ event: "message", data: "not json" }));
		act(() => reader.onMessage?.({ event: "message", data: JSON.stringify({ id: "2", log_chunk: 7 }) }));
		expect(result.current.logs.map((l) => l.id)).toEqual([1]);
	});

	it("passes the reader's state and reconnect through, for the page to show", () => {
		reader.state = "closed";
		const { result } = renderHook(() => useJobLogStream("job-1", { lines: [], lastId: 0 }, true));
		expect(result.current.state).toBe("closed");
		expect(result.current.reconnect).toBe(reader.reconnect);
	});

	it("moving to another job without a remount resumes after THAT job's head", () => {
		const { rerender } = renderHook(({ id, head }) => useJobLogStream(id, head, true), {
			initialProps: { id: "job-1", head: { lines: [line(1), line(2)], lastId: 2 } },
		});
		rerender({ id: "job-2", head: { lines: [line(10)], lastId: 10 } });
		expect(opened()).toEqual(["/api/stream/jobs/job-1?after=2", "/api/stream/jobs/job-2?after=10"]);
	});

	// #6459: the streamed tail belongs to the job that sent it, not cleared by an effect. This pins
	// the outcome, not the timing.
	it("drops the previous job's streamed tail the moment it moves to another job", () => {
		const { result, rerender } = renderHook(({ id, head }) => useJobLogStream(id, head, true), {
			initialProps: { id: "job-1", head: { lines: [line(1)], lastId: 1 } },
		});
		deliver(line(2));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);

		rerender({ id: "job-2", head: { lines: [line(10)], lastId: 10 } });
		expect(result.current.logs.map((l) => l.id)).toEqual([10]);
		deliver(line(11));
		expect(result.current.logs.map((l) => l.id)).toEqual([10, 11]);
	});

	it("with no head (the plan flow), streams the whole backlog at once", () => {
		renderHook(() => useJobLogStream("job-1"));
		expect(opened()).toEqual(["/api/stream/jobs/job-1"]);
	});

	it("a caller that does not follow the job's status is told the log is complete by the stream itself", () => {
		const { result } = renderHook(() => useJobLogStream("job-1"));
		deliver(line(1));
		end();
		expect(result.current.logs.map((l) => l.id)).toEqual([1]);
		expect(result.current.complete).toBe(true);
		// No stream any more: nothing to read "disconnected", nothing to reconnect.
		expect(reader.addresses.at(-1)).toBeNull();
		expect(result.current.state).toBeNull();
	});
});

describe("useJobLogStream — a finished job gets no stream", () => {
	it("opens nothing when the job had finished and its head is the whole log", () => {
		const head = { lines: [line(1), line(2)], lastId: 2, final: true };
		const { result } = renderHook(() => useJobLogStream("job-1", head, true, { finished: true }));
		expect(opened()).toEqual([]);
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
		expect(result.current.state).toBeNull();
		expect(result.current.complete).toBe(true);
	});

	it("asks once for the rest when the head is not the whole log, and stops at the end event", () => {
		// More lines than the head holds, or a job that finished a moment ago: `final` is false.
		const head = { lines: [line(1), line(2)], lastId: 2, final: false };
		const { result } = renderHook(() => useJobLogStream("job-1", head, true, { finished: true }));
		expect(opened()).toEqual(["/api/stream/jobs/job-1?after=2&rest=1"]);
		expect(result.current.complete).toBe(false);

		deliver(line(3));
		end();
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3]);
		expect(result.current.complete).toBe(true);
		expect(reader.addresses.at(-1)).toBeNull();
		expect(opened()).toHaveLength(1);
	});

	it("a head whose read failed is not the whole log: the rest is asked for from the start", () => {
		renderHook(() => useJobLogStream("job-1", undefined, true, { finished: true }));
		expect(opened()).toEqual(["/api/stream/jobs/job-1?rest=1"]);
	});
});

describe("useJobLogStream — a job that finishes while its page is open", () => {
	it("asks for the rest after the last line HELD, so nothing already delivered is sent again", () => {
		const head = { lines: [line(1), line(2)], lastId: 2 };
		const { result, rerender } = renderHook(({ finished }) => useJobLogStream("job-1", head, true, { finished }), {
			initialProps: { finished: false },
		});
		deliver(line(3));
		deliver(line(4));

		rerender({ finished: true });
		expect(opened()).toEqual(["/api/stream/jobs/job-1?after=2", "/api/stream/jobs/job-1?after=4&rest=1"]);
		// The lines held are still on screen across the change of stream.
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3, 4]);

		deliver(line(5));
		end();
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
		expect(result.current.complete).toBe(true);
		expect(opened()).toHaveLength(2);
	});

	it("opens the rest request even when the live stream delivered nothing since the head", () => {
		const head = { lines: [line(1)], lastId: 1 };
		const { rerender } = renderHook(({ finished }) => useJobLogStream("job-1", head, true, { finished }), {
			initialProps: { finished: false },
		});
		rerender({ finished: true });
		// Same resume point, different address: without that the reader would keep the live stream.
		expect(opened()).toEqual(["/api/stream/jobs/job-1?after=1", "/api/stream/jobs/job-1?after=1&rest=1"]);
	});

	it("does not ask twice: further renders of a finished job open nothing more", () => {
		const head = { lines: [line(1)], lastId: 1 };
		const { rerender } = renderHook(({ finished }) => useJobLogStream("job-1", head, true, { finished }), {
			initialProps: { finished: false },
		});
		rerender({ finished: true });
		rerender({ finished: true });
		deliver(line(2));
		rerender({ finished: true });
		expect(opened()).toHaveLength(2);
	});
});
