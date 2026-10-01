// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The kubeconfig mint expiry sweep (#5281; #5292 advisory 5). Hosted on the supervised reconcile loop
// (lib/reconcile/loop.ts) as `kubeconfig-mint-sweep`, every minute — the same host as the other
// time-sensitive reconcilers, so it is heartbeat-supervised and a throw never stops its siblings.
//
// Two phases, in this order, each one statement:
//
//   1. EXPIRE. Every row past its poll window that is not already `expired` becomes `expired`, and
//      its ciphertext is NULLED in the same UPDATE (the sealed_iff_ready CHECK would refuse anything
//      else). The ciphertext is opaque to the console — only the client's ephemeral key opens it —
//      but a sealed credential nobody collected has no reason to outlive its window. A MINT_KUBECONFIG
//      job of an expired mint that is still QUEUED is CANCELLED in the same transaction: nobody is
//      waiting for it, and a runner that claimed it later would mint a credential into the cluster for
//      no one. A job a runner already holds is left alone; its result post is refused (the row is
//      past its window) and the runner fails it.
//   2. DELETE. Rows that expired more than one further window ago are deleted. The grace keeps the
//      row long enough that a client still polling hears `expired` rather than a bare 404.
//
// Service role, global, no actor: the sweep acts on every org's rows by design, and touches nothing
// but rows whose own `expires_at` has passed. Idempotent and safe under concurrent app instances —
// a second instance's UPDATE finds the rows already `expired`, its DELETE finds them already gone.

import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { jobs, kubeconfigMintRequests } from "@/lib/db/schema";
import { KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS } from "@/lib/db/schema/kubeconfig-mints";

/** How long an expired row is kept (so a late poll reads `expired`) before it is deleted. */
const KUBECONFIG_MINT_DELETE_GRACE_SECONDS =
	KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS;

/** The job error a cancelled, never-claimed mint carries. Fixed text, like every mint reason. */
const EXPIRED_JOB_MESSAGE =
	"The kubeconfig mint expired before a runner claimed it.";

/** What one sweep pass did. A type alias, not an interface, so it is assignable to the heartbeat's
 *  `Record<string, number>` result shape (lib/reconcile/heartbeat.ts). */
export type MintSweepResult = {
	expired: number;
	cancelledJobs: number;
	deleted: number;
};

/**
 * Expires every mint request past its window (nulling its ciphertext), cancels the still-queued jobs
 * of those mints, then deletes the rows past the grace period. Returns the counts for the heartbeat.
 */
export async function sweepExpiredKubeconfigMints(db: Db): Promise<MintSweepResult> {
	const { expired, cancelledJobs } = await db.transaction(async (tx) => {
		const rows = await tx
			.update(kubeconfigMintRequests)
			.set({ status: "expired", sealed_result: null, failure_reason: null })
			.where(
				and(
					lte(kubeconfigMintRequests.expires_at, sql`now()`),
					ne(kubeconfigMintRequests.status, "expired"),
				),
			)
			.returning({ job_id: kubeconfigMintRequests.job_id });

		const jobIds = rows
			.map((r) => r.job_id)
			.filter((id): id is string => id !== null);
		let cancelled = 0;
		if (jobIds.length > 0) {
			const moved = await tx
				.update(jobs)
				.set({
					status: "CANCELLED",
					error_message: EXPIRED_JOB_MESSAGE,
					completed_at: sql`now()`,
					updated_at: sql`now()`,
				})
				.where(
					and(
						inArray(jobs.id, jobIds),
						eq(jobs.job_type, "MINT_KUBECONFIG"),
						eq(jobs.status, "QUEUED"),
					),
				)
				.returning({ id: jobs.id });
			cancelled = moved.length;
		}
		return { expired: rows.length, cancelledJobs: cancelled };
	});

	const deleted = await db
		.delete(kubeconfigMintRequests)
		.where(
			lte(
				kubeconfigMintRequests.expires_at,
				sql`now() - make_interval(secs => ${KUBECONFIG_MINT_DELETE_GRACE_SECONDS})`,
			),
		)
		.returning({ id: kubeconfigMintRequests.id });

	return { expired, cancelledJobs, deleted: deleted.length };
}
