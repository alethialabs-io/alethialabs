// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A job's log read from a cursor, for the MCP `get_job_logs` tool. The same visibility rule as the
// job detail page's head read (lib/rpc/procedures/jobs.ts): the PDP's `view` on the job, then the
// job-visibility predicate, inside the reader's tenancy scope.

import "server-only";
import { and, asc, eq, gt } from "drizzle-orm";
import { JOB_FINISHED_STATUSES, JOB_LOG_SETTLE_MS } from "@/components/jobs/job-log-contract";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { jobLogs, jobs } from "@/lib/db/schema";
import { jobVisibleTo } from "@/lib/jobs/visibility";

/** One page of a job's log. */
export interface JobLogPage {
	/** The lines after the cursor, oldest first. */
	lines: { id: number; log_chunk: string }[];
	/** True when the job has finished and its log has settled, so nothing more will be written. */
	settled: boolean;
}

/**
 * Up to `limit` log lines of job `jobId` with an id above `afterId`, oldest first. Refuses
 * (not-found) a job the reader cannot see.
 */
export async function readJobLogPage(jobId: string, afterId: number, limit: number): Promise<JobLogPage> {
	const actor = await authorize("view", { type: "job", id: jobId });
	const visible = await jobVisibleTo(actor);
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [job] = await tx
			.select({ status: jobs.status, completed_at: jobs.completed_at })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), visible))
			.limit(1);
		if (!job) throw new ActionRefusal("not-found", "Job not found.");
		const settled =
			JOB_FINISHED_STATUSES.has(job.status) &&
			job.completed_at != null &&
			Date.now() - job.completed_at.getTime() > 2 * JOB_LOG_SETTLE_MS;
		const lines = await tx
			.select({ id: jobLogs.id, log_chunk: jobLogs.log_chunk })
			.from(jobLogs)
			.where(and(eq(jobLogs.job_id, jobId), gt(jobLogs.id, afterId)))
			.orderBy(asc(jobLogs.id))
			.limit(limit);
		return { lines, settled };
	});
}
