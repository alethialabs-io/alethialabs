// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useMemo, useState } from "react";

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
}

/** Head lines then streamed lines, each id once, in id order. */
export function mergeLogLines(head: readonly JobLogEntry[], streamed: readonly JobLogEntry[]): JobLogEntry[] {
	const byId = new Map<number, JobLogEntry>();
	for (const line of head) byId.set(line.id, line);
	for (const line of streamed) if (!byId.has(line.id)) byId.set(line.id, line);
	return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The stream's address: the job's SSE endpoint, resuming after `after` when it is past zero. */
export function jobLogStreamUrl(jobId: string, after: number): string {
	return after > 0 ? `/api/stream/jobs/${jobId}?after=${after}` : `/api/stream/jobs/${jobId}`;
}

/**
 * A job's log: the HEAD the page read with its first paint, then the live tail over SSE
 * (/api/stream/jobs/:id). The stream opens once the head has settled and resumes after the head's
 * last line, so the backlog is not sent twice; it is opened ONCE per job — a later refetch of the
 * head (an invalidation) merges in, it does not reconnect. A failed head read opens the stream
 * from the start, which then sends the whole backlog itself. The browser's EventSource
 * auto-reconnects and resumes from the last id it saw (Last-Event-ID).
 *
 * A caller with no head (the plan flow, the agent's artifact panel) passes only `jobId`: the stream
 * opens at once and sends the whole backlog.
 */
export function useJobLogStream(
	jobId: string | null,
	head?: JobLogHead,
	headSettled = true,
): { logs: JobLogEntry[] } {
	const [streamed, setStreamed] = useState<JobLogEntry[]>([]);
	// Where the stream resumes, fixed the first time the head settles FOR THIS JOB: keyed by the job,
	// so moving to another job without a remount starts from that job's head, not this one's.
	const [resume, setResume] = useState<{ jobId: string; after: number } | null>(null);
	const headLastId = head?.lastId ?? 0;

	useEffect(() => {
		if (!jobId || !headSettled) return;
		setResume((fixed) => (fixed?.jobId === jobId ? fixed : { jobId, after: headLastId }));
	}, [jobId, headSettled, headLastId]);
	const after = resume !== null && resume.jobId === jobId ? resume.after : null;

	useEffect(() => {
		setStreamed([]);
		if (!jobId || after === null) return;

		const es = new EventSource(jobLogStreamUrl(jobId, after));
		es.onmessage = (e) => {
			let row: JobLogEntry;
			try {
				row = JSON.parse(e.data);
			} catch {
				return;
			}
			setStreamed((prev) => (prev.some((l) => l.id === row.id) ? prev : [...prev, row]));
		};
		// On error EventSource auto-reconnects and resumes via Last-Event-ID.
		es.onerror = () => {};

		return () => es.close();
	}, [jobId, after]);

	const logs = useMemo(() => mergeLogLines(head?.lines ?? [], streamed), [head, streamed]);
	return { logs };
}
