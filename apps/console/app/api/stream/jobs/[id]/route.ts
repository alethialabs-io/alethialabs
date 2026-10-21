// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, gt } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeUserId } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobLogs, jobs } from "@/lib/db/schema";
import { holdRequest } from "@/lib/http/hold-request";
import { isJobVisible } from "@/lib/jobs/visibility";
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
 * RealtimeTransport).
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

	// This read uses the service DB (RLS-bypassing), so the tenant predicate is applied here by hand,
	// and it is the jobs `owner_all` RLS policy (programmables.sql): `org_id = current_org OR
	// org_id = current_owner` — the job's org is the active org, or the caller's PERSONAL org (whose
	// id is the user's id). The second arm keeps a job stamped `org_id = user_id` (the `set_org_id`
	// fallback, pre-#3942 runner jobs) streaming on a hosted org, as the list shows it. The predicate
	// is on the job's org alone: a job is reachable from the org it belongs to.
	const [job] = await db
		.select({
			org_id: jobs.org_id,
			project_id: jobs.project_id,
			job_type: jobs.job_type,
			environment_id: jobs.environment_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	// The PDP (authorizeUserId) gated the action above; this bounds the row to the caller's tenancy.
	const inScope = !!job && (job.org_id === actor.orgId || job.org_id === actor.userId); // authz-scope-ok
	if (!inScope) {
		return new Response("Not found", { status: 404 });
	}
	// Job visibility follows project visibility (lib/jobs/visibility.ts): a reader who may not view
	// the job's project is answered exactly as for a job that does not exist, as every jobs read is.
	if (!(await isJobVisible(actor, job))) {
		return new Response("Not found", { status: 404 });
	}

	const parsedAfter = Number.parseInt(
		req.headers.get("last-event-id") ??
			new URL(req.url).searchParams.get("after") ??
			"0",
		10,
	);
	let lastId = Number.isFinite(parsedAfter) ? parsedAfter : 0;

	// The client's disconnect, read once here. The `Request` must stay reachable while the stream runs:
	// its signal stops following the disconnect once the `Request` is collected, and nothing below
	// reads `req` again except the `holdRequest` in teardown (see lib/http/hold-request.ts).
	const signal = req.signal;
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
			/** Tear the stream down for a client that has gone: stop its work, then end the body. */
			const stop = () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
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
			// A client that left during the backlog read aborted before the listener below existed, and
			// an abort listener never hears an abort that already happened. Stop here, before the
			// subscription and the heartbeat exist; `closed` covers a `cancel()` that ran in the same gap.
			if (signal.aborted || closed) {
				stop();
				return;
			}
			unsubscribe = getRealtimeTransport().subscribe(jobId, () => {
				if (!closed) void drain();
			});

			heartbeat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(":\n\n"));
			}, 20_000);

			signal.addEventListener("abort", stop);
		},
		cancel() {
			cleanup();
		},
	});

	/** Stop the stream's work: the heartbeat and the log subscription. Runs once. */
	function cleanup() {
		// Keeps `req` reachable — and so `signal` live — until the stream is torn down.
		holdRequest(req);
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
