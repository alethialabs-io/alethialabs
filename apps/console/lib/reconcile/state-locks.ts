// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Release the state lock of a cancelled job whose runner never reported terminal (#7387), on the
// supervised reconcile loop: the `release-cancelled-state-locks` task (`loop.ts`).
//
// A cancelled apply keeps its tofu-state lock while its interrupted tofu saves state and unlocks
// (#7290). The lock normally ends with the runner's terminal report (releaseStateLocksForJob in the
// status route). A runner that dies after the cancel never sends that report, so the lock stays live
// until its 3h TTL, and every later job on the same state object, the cleanup DESTROY included, is
// held QUEUED by `state_object_busy` for that long.
//
// Past CANCELLED_HOLDER_DRAIN_MS the state routes already refuse the cancelled job's final write and
// unlock (lib/runners/state-auth.ts), so no tofu can still finish its drain through the console: the
// lock guards nothing a writer could still complete. This sweep releases it then, with the same
// fenced release the status route uses, and writes a SYSTEM log line on the job so the operator can
// see that the state may not include what the interrupted apply did.

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { CANCELLED_HOLDER_DRAIN_MS } from "@/lib/runners/state-auth";
import { releaseStateLocksForJob } from "@/lib/runners/state-lock";

/** The line written to a job whose lock this sweep released. Exported for the tests. */
export const LOCK_RELEASED_LOG_LINE =
	"state lock released after the runner did not report; state may be incomplete";

/** The paging bounds of one sweep. */
export interface CancelledLockSweepBounds {
	/** Jobs per page (one transaction each). */
	pageSize: number;
	/** Pages per run; a larger backlog drains over later runs. */
	maxPages: number;
}

/** Up to 500 jobs a run: one is already rare, it takes a runner dying mid-cancel. */
const DEFAULT_BOUNDS: CancelledLockSweepBounds = { pageSize: 50, maxPages: 10 };

/**
 * What one sweep did. A type alias, not an interface, so it satisfies the `Record<string, number>`
 * that `runTask` records on the heartbeat.
 */
export type CancelledLockSweepResult = {
	/** Jobs whose locks were released. */
	jobs: number;
	/** Lock rows released (normally one per job). */
	released: number;
};

/**
 * Releases one page of locks. Locks the JOB rows first (`FOR UPDATE OF j SKIP LOCKED`, so a second
 * app instance skips them) and re-checks nothing else: the release function is scoped to the job's
 * own lock rows, and rotating a lock that a late terminal report rotated a moment earlier is a
 * harmless second fence bump. The job row, not the lock row, is what is locked: a job's locks are
 * then released by exactly one transaction, so two instances cannot each lock one of a job's rows
 * and wait on the other's.
 *
 * Measured on the database's clock. `completed_at` is what every cancel path stamps; `updated_at`
 * stands in for a row without one, which the state routes already treat as outside the drain window.
 */
async function releasePage(db: Db, pageSize: number): Promise<CancelledLockSweepResult & { locked: number }> {
	return db.transaction(async (tx) => {
		const candidates = await tx.execute<{ id: string }>(sql`
			select j.id
			  from public.jobs j
			 where j.status = 'CANCELLED'
			   and coalesce(j.completed_at, j.updated_at)
			       < now() - make_interval(secs => ${CANCELLED_HOLDER_DRAIN_MS / 1000})
			   and exists (
			       select 1 from public.tofu_state_locks l
			        where l.job_id = j.id and l.expires_at > now()
			   )
			 order by j.completed_at
			 limit ${pageSize}
			   for update of j skip locked`);

		const result = { jobs: 0, released: 0, locked: candidates.length };
		for (const { id } of candidates) {
			const released = await releaseStateLocksForJob(id, tx);
			if (released === 0) continue;
			result.jobs++;
			result.released += released;
			const [line] = await tx.execute<{ id: number }>(sql`
				insert into public.job_logs (job_id, log_chunk, stream_type, traceparent)
				select j.id, ${LOCK_RELEASED_LOG_LINE}, 'SYSTEM', j.traceparent
				  from public.jobs j where j.id = ${id}::uuid
				returning id`);
			// The same notification insert_job_log sends, so a console watching the job sees the line.
			if (line) {
				await tx.execute(
					sql`select pg_notify('job_logs', json_build_object('jobId', ${id}::uuid, 'logId', ${line.id}::bigint)::text)`,
				);
			}
		}
		return result;
	});
}

/**
 * The `release-cancelled-state-locks` task: releases every live state lock held by a CANCELLED job
 * whose cancel is older than {@link CANCELLED_HOLDER_DRAIN_MS}, and logs it on the job. Service role,
 * global: `db` is the service-role pool the reconcile loop passes. Runs page by page up to the bounds
 * and stops when a page comes back short.
 */
export async function releaseCancelledStateLocks(
	db: Db,
	bounds: CancelledLockSweepBounds = DEFAULT_BOUNDS,
): Promise<CancelledLockSweepResult> {
	const total: CancelledLockSweepResult = { jobs: 0, released: 0 };
	for (let i = 0; i < bounds.maxPages; i++) {
		const page = await releasePage(db, bounds.pageSize);
		total.jobs += page.jobs;
		total.released += page.released;
		if (page.locked < bounds.pageSize) break;
	}
	return total;
}
