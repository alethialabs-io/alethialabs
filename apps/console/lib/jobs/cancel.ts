// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CANCELLING A JOB — one implementation, for the console's action and the CLI's route (#6121), so
// the two surfaces cannot drift apart again. What each surface brings is only how it reaches the
// database (the console through RLS as the actor; the CLI through the service connection beside
// its org-scope predicate) and how it reports the outcome; the rule is here:
//
//   1. The job is read through the caller's tenancy predicate and job visibility. A job outside
//      them is "not found".
//   2. Cancelling takes the permission its operation takes on its target (lib/jobs/operation.ts),
//      enforced through the PDP, beyond the `edit` on the job the caller already checked.
//   3. The flip is CONDITIONAL — only from QUEUED, CLAIMED or PROCESSING — and stamps
//      `completed_at`. A job that reached a terminal status between the read and the write is not
//      rewritten: nothing flips, and the caller is told it can no longer be cancelled.
//   4. The runner is signalled from what the flip ACTUALLY changed: a row that had been claimed by a
//      runner (its `runner_id` is set) is torn down mid-flight; one still QUEUED needs no signal.
//      The signal goes after the write commits, and a failed delivery never fails the cancel.

import "server-only";

import { and, eq, inArray, type SQL } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { ResolvedScope } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { permissionToCancel } from "@/lib/jobs/operation";
import { notifyRunnerCancel } from "@/lib/runners/cancel-signal";

/** The statuses a job can be cancelled from. */
const CANCELLABLE = ["QUEUED", "CLAIMED", "PROCESSING"] as const;

/** Runs one unit of work against the database the caller reads through. */
export type RunInScope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

/** How a cancel ended. */
export type CancelOutcome =
	| { kind: "cancelled"; signalled: boolean }
	| { kind: "not-found" }
	/** The job is not in a cancellable status (it may have finished between the read and the write). */
	| { kind: "not-cancellable"; status: string }
	/** The target the permission is asked about cannot be named. */
	| { kind: "no-target" };

/**
 * Cancels `jobId` as `actor`, through `run` and the tenancy predicate `where`. The PDP's refusal
 * is THROWN (`ForbiddenError`), as `enforce` throws everywhere, so each surface maps it as it maps
 * any other refusal.
 */
export async function cancelJobAs(
	actor: ResolvedScope,
	jobId: string,
	where: SQL,
	run: RunInScope,
	message = "Cancelled by user",
): Promise<CancelOutcome> {
	const [job] = await run((tx) =>
		tx
			.select({
				status: jobs.status,
				job_type: jobs.job_type,
				project_id: jobs.project_id,
				environment_id: jobs.environment_id,
				config_snapshot: jobs.config_snapshot,
			})
			.from(jobs)
			.where(and(eq(jobs.id, jobId), where))
			.limit(1),
	);
	if (!job) return { kind: "not-found" };

	const permission = permissionToCancel(job);
	if (permission !== null) {
		if (permission.id === null) return { kind: "no-target" };
		await getPdp().enforce(actor, permission.action, { type: permission.type, id: permission.id });
	}

	const [flipped] = await run((tx) =>
		tx
			.update(jobs)
			.set({ status: "CANCELLED", error_message: message, completed_at: new Date() })
			.where(and(eq(jobs.id, jobId), where, inArray(jobs.status, [...CANCELLABLE])))
			.returning({ runner_id: jobs.runner_id }),
	);
	if (!flipped) {
		const [now] = await run((tx) =>
			tx.select({ status: jobs.status }).from(jobs).where(and(eq(jobs.id, jobId), where)).limit(1),
		);
		return { kind: "not-cancellable", status: now?.status ?? job.status };
	}

	// What the flip changed decides the signal: a runner had claimed it iff its runner_id is set.
	if (flipped.runner_id) {
		await notifyRunnerCancel(flipped.runner_id, jobId).catch(() => {});
		return { kind: "cancelled", signalled: true };
	}
	return { kind: "cancelled", signalled: false };
}
