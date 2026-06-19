// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, gt } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeUserId } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobLogs, jobs } from "@/lib/db/schema";
import { getRealtimeTransport } from "@/lib/realtime";

export const dynamic = "force-dynamic";

type LogRow = {
	id: number;
	log_chunk: string;
	stream_type: string;
	created_at: Date;
};

/**
 * SSE stream of a job's logs. Sends the backlog since the client's Last-Event-ID,
 * then streams new rows as the runner writes them (Postgres LISTEN/NOTIFY via the
 * RealtimeTransport). Replaces the Supabase Realtime job_logs subscription.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });

	const { id: jobId } = await params;

	const forbid = await authorizeUserId(owner, "view", { type: "job", id: jobId });
	if (forbid) return forbid;
	const actor = await getActiveScope(owner);
	const db = getServiceDb();

	const [job] = await db
		.select({ org_id: jobs.org_id })
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	if (!job || job.org_id !== actor.orgId) {
		return new Response("Not found", { status: 404 });
	}

	const parsedAfter = Number.parseInt(
		req.headers.get("last-event-id") ??
			new URL(req.url).searchParams.get("after") ??
			"0",
		10,
	);
	let lastId = Number.isFinite(parsedAfter) ? parsedAfter : 0;

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const fetchSince = (after: number): Promise<LogRow[]> =>
		db
			.select({
				id: jobLogs.id,
				log_chunk: jobLogs.log_chunk,
				stream_type: jobLogs.stream_type,
				created_at: jobLogs.created_at,
			})
			.from(jobLogs)
			.where(and(eq(jobLogs.job_id, jobId), gt(jobLogs.id, after)))
			.orderBy(asc(jobLogs.id));

	const stream = new ReadableStream({
		async start(controller) {
			const send = (rows: LogRow[]) => {
				for (const r of rows) {
					controller.enqueue(
						encoder.encode(`id: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`),
					);
					if (r.id > lastId) lastId = r.id;
				}
			};

			// Drain loop — coalesces bursts and never drops a notify that arrives
			// mid-fetch (each new log id > lastId is picked up on the next pass).
			let draining = false;
			let pending = false;
			const drain = async () => {
				if (draining) {
					pending = true;
					return;
				}
				draining = true;
				try {
					do {
						pending = false;
						send(await fetchSince(lastId));
					} while (pending && !closed);
				} catch {
					/* transient read error; next notify retries */
				} finally {
					draining = false;
				}
			};

			await drain(); // backlog
			unsubscribe = getRealtimeTransport().subscribe(jobId, () => {
				if (!closed) void drain();
			});

			heartbeat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(":\n\n"));
			}, 20_000);

			req.signal.addEventListener("abort", () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			cleanup();
		},
	});

	function cleanup() {
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		if (unsubscribe) unsubscribe();
	}

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
