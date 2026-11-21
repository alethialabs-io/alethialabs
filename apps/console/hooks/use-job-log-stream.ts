// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useMemo, useState } from "react";
import { z } from "zod";
import { JOB_LOG_END_EVENT, jobLogStreamUrl } from "@/components/jobs/job-log-contract";
import { type EventStreamMessage, type EventStreamState, useEventStream } from "@/hooks/use-event-stream";

/** One log line, as both the head read (`jobs.logsHead`) and the SSE stream deliver it. */
export interface JobLogEntry {
	id: number;
	log_chunk: string;
	stream_type: string | null;
	created_at: string;
}

/** The head of a job's log, read with the page (`jobs.logsHead`). */
export interface JobLogHead {
	lines: JobLogEntry[];
	lastId: number;
	/** True when these lines are the whole log and nothing will be added (`JobLogsHead.final`). */
	final?: boolean;
}

/** A stream message's data, checked: it comes off the network, so its type is not evidence of its shape. */
const logLineSchema = z.object({
	id: z.number(),
	log_chunk: z.string(),
	stream_type: z.string().nullable(),
	created_at: z.string(),
});

/** The line a stream message carries, or null when its data is not one. */
function parseLogLine(data: string): JobLogEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(data);
	} catch {
		return null;
	}
	const parsed = logLineSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Head lines then streamed lines, each id once, in id order. Both lists arrive in id order — the
 * head read and the stream both sort by it — so this is the head followed by whatever the stream
 * holds PAST the head's last line: one copy, no scan per line.
 */
export function mergeLogLines(head: readonly JobLogEntry[], streamed: readonly JobLogEntry[]): JobLogEntry[] {
	const lastHeadId = head.at(-1)?.id ?? 0;
	let start = 0;
	while (start < streamed.length && (streamed[start]?.id ?? 0) <= lastHeadId) start += 1;
	return [...head, ...(start === 0 ? streamed : streamed.slice(start))];
}

/** How many lines one block of the streamed tail holds. */
const TAIL_BLOCK = 500;

/**
 * The lines the stream has delivered for one job, in blocks. A new line copies the last block and
 * the list of blocks — a few hundred references — not every line received so far, which is what
 * keeps a fifty-thousand-line log from costing a full copy per line.
 */
export interface JobLogTail {
	jobId: string | null;
	blocks: readonly (readonly JobLogEntry[])[];
	/** The id of the last line held; a line at or below it has already been received. */
	lastId: number;
}

/** No streamed lines — one stable value, so the merge's memo holds. */
export const EMPTY_JOB_LOG_TAIL: JobLogTail = { jobId: null, blocks: [], lastId: 0 };

/**
 * `tail` with `line` appended, or `tail` itself when the line is not new. Lines arrive in id order
 * and a reconnect resumes after the last id seen, so "not past the last id" is exactly "a repeat".
 */
export function appendLogLine(tail: JobLogTail, line: JobLogEntry): JobLogTail {
	if (line.id <= tail.lastId) return tail;
	const last = tail.blocks.at(-1);
	const blocks =
		last !== undefined && last.length < TAIL_BLOCK
			? [...tail.blocks.slice(0, -1), [...last, line]]
			: [...tail.blocks, [line]];
	return { jobId: tail.jobId, blocks, lastId: line.id };
}

/**
 * Which stream a job's log needs, fixed when the head settles for that job and moved forward as
 * the job and the stream do:
 *
 * - `live` — the job is running: the stream stays open and lines arrive as they are written;
 * - `rest` — the job has finished and lines may still be missing: one more request, which the
 *   route answers with what is left and the end event;
 * - `done` — every line is held. There is no stream.
 */
interface Plan {
	jobId: string;
	/** The line id the stream resumes after. */
	after: number;
	mode: "live" | "rest" | "done";
}

/** What {@link useJobLogStream} is told beyond the job and its head. */
export interface JobLogStreamOptions {
	/**
	 * Whether the job is known to have finished. A caller that does not follow the job's status
	 * leaves it out: the stream then stays open until the route itself says the log is complete.
	 */
	finished?: boolean;
}

/** A job's log and where its stream stands. */
export interface JobLogStream {
	logs: JobLogEntry[];
	/**
	 * The stream's state (`hooks/use-event-stream.ts`), or null when there is no stream: the head
	 * has not settled yet, or the log is complete. `closed` is the one a caller must show, with
	 * `reconnect` on its button; `signed-out` belongs to the shell.
	 */
	state: EventStreamState | null;
	/** Opens the stream again, resuming after the last line received. For the `closed` state. */
	reconnect: () => void;
	/** True once every line of the log is held: nothing more will arrive and there is no stream. */
	complete: boolean;
}

/**
 * A job's log: the HEAD the page read with its first paint, then the tail over the job's event
 * stream (/api/stream/jobs/:id), read with `useEventStream` (lib/realtime/README.md, rule 2).
 *
 * WHEN THERE IS A STREAM, AND WHEN THERE IS NOT:
 *
 * - It opens once the head has settled and resumes after the head's last line, so the backlog is
 *   not sent twice. A later refetch of the head merges in; it does not reconnect. A failed head
 *   read opens the stream from the start, which then sends the whole backlog itself.
 * - A job that had already finished when the head was read, and whose head is the whole log
 *   (`head.final`), gets NO stream: nothing more can arrive, so nothing is requested and nothing
 *   can read "disconnected".
 * - A job that finishes while its stream is open is asked once more for what is left. The route
 *   sends it, then the end event, and the stream is over.
 * - A stream that drops is opened again by `useEventStream`, resuming after the last line it
 *   delivered (`Last-Event-ID`), so a reconnect neither repeats a line nor skips one; a repeat that
 *   did arrive would be dropped here by its id. When its attempts run out the state is `closed`.
 *
 * A caller with no head (the plan flow, the agent's artifact panel) passes only `jobId`: the stream
 * opens at once, sends the whole backlog, and ends when the route says the job's log is complete.
 */
export function useJobLogStream(
	jobId: string | null,
	head?: JobLogHead,
	headSettled = true,
	options: JobLogStreamOptions = {},
): JobLogStream {
	const finished = options.finished ?? false;
	const [plan, setPlan] = useState<Plan | null>(null);
	// The streamed lines belong to the job that sent them: another job starts from none, read off
	// the job id rather than cleared by an effect.
	const [tail, setTail] = useState<JobLogTail>(EMPTY_JOB_LOG_TAIL);
	const held = tail.jobId === jobId ? tail : EMPTY_JOB_LOG_TAIL;
	const headLastId = head?.lastId ?? 0;
	const headFinal = head?.final === true;

	// Both steps below are set while rendering (React's "adjust state while rendering" form: each
	// condition is false once its state is set), so the render in which the head settles, or the
	// job finishes, already knows which stream to open.
	const current = plan !== null && plan.jobId === jobId ? plan : null;
	if (jobId && headSettled && current === null) {
		setPlan({
			jobId,
			after: headLastId,
			mode: finished ? (headFinal ? "done" : "rest") : "live",
		});
	} else if (current !== null && current.mode === "live" && finished) {
		// Resume after the last line HELD, not after the head: what the live stream delivered is
		// not asked for again.
		setPlan({ jobId: current.jobId, after: Math.max(current.after, held.lastId), mode: "rest" });
	}

	const url =
		current === null || current.mode === "done"
			? null
			: jobLogStreamUrl(current.jobId, current.after, current.mode === "rest");

	/** Takes one stream message: a log line is appended, the end event closes the log. */
	const onMessage = (message: EventStreamMessage): void => {
		if (!jobId) return;
		if (message.event === JOB_LOG_END_EVENT) {
			setPlan((prev) => (prev !== null && prev.jobId === jobId ? { ...prev, mode: "done" } : prev));
			return;
		}
		const line = parseLogLine(message.data);
		if (line === null) return;
		setTail((prev) => appendLogLine(prev.jobId === jobId ? prev : { ...EMPTY_JOB_LOG_TAIL, jobId }, line));
	};
	const stream = useEventStream(url, { onMessage });

	const logs = useMemo(() => mergeLogLines(head?.lines ?? [], held.blocks.flat()), [head, held]);
	return {
		logs,
		state: stream.state,
		reconnect: stream.reconnect,
		complete: current !== null && current.mode === "done",
	};
}
