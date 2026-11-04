// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6121: the job page paints the HEAD of its log from the server, then streams the tail. The stream
// must resume after the head (not resend the backlog), open once per job (a refetched head merges,
// it does not reconnect), and wait for the head before opening at all.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type JobLogEntry,
	jobLogStreamUrl,
	mergeLogLines,
	useJobLogStream,
} from "@/hooks/use-job-log-stream";

/** A stand-in EventSource that records every stream opened. */
class FakeEventSource {
	static opened: FakeEventSource[] = [];
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.opened.push(this);
	}
	close() {
		this.closed = true;
	}
}

const line = (id: number, chunk = `line ${id}`): JobLogEntry => ({
	id,
	log_chunk: chunk,
	stream_type: "STDOUT",
	created_at: "2026-10-20T10:00:00.000Z",
});

beforeEach(() => {
	FakeEventSource.opened = [];
	vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("mergeLogLines", () => {
	it("keeps each id once, in id order, head first", () => {
		expect(mergeLogLines([line(1), line(2)], [line(2, "dup"), line(3)]).map((l) => [l.id, l.log_chunk])).toEqual([
			[1, "line 1"],
			[2, "line 2"],
			[3, "line 3"],
		]);
	});
});

describe("jobLogStreamUrl", () => {
	it("resumes after the head's last line, and sends the whole backlog from zero", () => {
		expect(jobLogStreamUrl("j", 42)).toBe("/api/stream/jobs/j?after=42");
		expect(jobLogStreamUrl("j", 0)).toBe("/api/stream/jobs/j");
	});
});

describe("useJobLogStream", () => {
	it("shows the head, then opens the stream after its last line and appends the tail", () => {
		const head = { lines: [line(1), line(2)], lastId: 2 };
		const { result } = renderHook(() => useJobLogStream("job-1", head, true));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
		expect(FakeEventSource.opened.map((e) => e.url)).toEqual(["/api/stream/jobs/job-1?after=2"]);

		act(() => FakeEventSource.opened[0]?.onmessage?.({ data: JSON.stringify(line(3)) }));
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2, 3]);
	});

	it("does not open the stream before the head has settled", () => {
		renderHook(() => useJobLogStream("job-1", undefined, false));
		expect(FakeEventSource.opened).toEqual([]);
	});

	it("opens ONCE: a refetched head merges in without reconnecting", () => {
		const { rerender, result } = renderHook(
			({ head }) => useJobLogStream("job-1", head, true),
			{ initialProps: { head: { lines: [line(1)], lastId: 1 } } },
		);
		rerender({ head: { lines: [line(1), line(2)], lastId: 2 } });
		expect(FakeEventSource.opened).toHaveLength(1);
		expect(FakeEventSource.opened[0]?.closed).toBe(false);
		expect(result.current.logs.map((l) => l.id)).toEqual([1, 2]);
	});

	it("moving to another job without a remount resumes after THAT job's head", () => {
		const { rerender } = renderHook(({ id, head }) => useJobLogStream(id, head, true), {
			initialProps: { id: "job-1", head: { lines: [line(1), line(2)], lastId: 2 } },
		});
		rerender({ id: "job-2", head: { lines: [line(10)], lastId: 10 } });
		expect(FakeEventSource.opened.map((e) => e.url)).toEqual([
			"/api/stream/jobs/job-1?after=2",
			"/api/stream/jobs/job-2?after=10",
		]);
		expect(FakeEventSource.opened[0]?.closed).toBe(true);
	});

	it("with no head (the plan flow), streams the whole backlog at once", () => {
		renderHook(() => useJobLogStream("job-1"));
		expect(FakeEventSource.opened.map((e) => e.url)).toEqual(["/api/stream/jobs/job-1"]);
	});
});
