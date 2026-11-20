// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the three parties to a job's log agree on: the read that paints its head
// (`readJobLogsHead`, lib/rpc/procedures/jobs.ts), the route that streams its tail
// (app/api/stream/jobs/[id]/route.ts) and the hook that reads both (hooks/use-job-log-stream.ts).
// Pure — no React, no server imports — so a route handler, a server-only reader and a client hook
// can all import it. A constant exported from a `"use client"` module would reach the route as a
// client reference, not as its value.

/** The statuses after which a job writes no more log lines, once the settle window has passed. */
export const JOB_FINISHED_STATUSES: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/**
 * How long after a job finishes its log can still gain lines. A runner reports the terminal status
 * before its loggers have shipped their last buffer (apps/runner/internal/agent/runner.go: the
 * terminal post runs ahead of the deferred `Close()` of the stdout and system loggers); they flush
 * within a second and the write then crosses the network. The stream waits this long after the job
 * finished before it says the log is complete.
 */
export const JOB_LOG_SETTLE_MS = 5_000;

/**
 * The SSE event the stream sends last: the job has finished, the settle window has passed and
 * every line has been sent. It carries no `id:`, so a reader's resume point stays on the last LINE.
 */
export const JOB_LOG_END_EVENT = "end";

/**
 * The stream's address: the job's SSE endpoint, resuming after `after` when it is past zero.
 *
 * `rest` marks the request a reader makes once it KNOWS the job has finished and wants what is
 * left. The route answers every request for a finished job the same way — the remaining lines,
 * then the end — and does not read the flag; it is in the address so that this request is a
 * different address from the live one, which is what makes the reader open it.
 */
export function jobLogStreamUrl(jobId: string, after: number, rest = false): string {
	const params = new URLSearchParams();
	if (after > 0) params.set("after", String(after));
	if (rest) params.set("rest", "1");
	const query = params.toString();
	return query === "" ? `/api/stream/jobs/${jobId}` : `/api/stream/jobs/${jobId}?${query}`;
}
