// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the console does when a job ends FAILED — ONE place, so every path that fails a job leaves the
// same state behind.
//
// A job reaches FAILED two ways: the runner reports it (PUT /api/jobs/[id]/status) or the console
// refuses it at claim (/api/jobs/claim — a snapshot whose signature does not verify, or a DEPLOY a
// runner cannot run safely). Setting `jobs.status` is not the whole of a failure. Without the rest, a
// claim-time refusal left the environment QUEUED until the converge sweep, nobody was alerted, and a
// promotion's DEPLOY left the promotion DEPLOYING for good — holding its target environment and its
// one-active-promotion slot, so the redeploy the refusal asked for could not be started (#6228's
// shape). Both paths now call this, in the order the status route has always used.

import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { finalizeChartScan } from "@/lib/addons/chart-scan-finalize";
import { finalizeIacScan } from "@/lib/addons/iac-scan-finalize";
import { type EnvStatusDb, type EnvTransitionContext, transitionEnv } from "@/lib/db/env-status";
import type { jobs } from "@/lib/db/schema";
import { setIacSourceStatus } from "@/lib/jobs/finalize-deployment";
import type { Logger } from "@/lib/observability/log";
import { failPromotionForJob } from "@/lib/promotions/lifecycle";

/** The columns of a failed job this reads. */
export type FailedJob = Pick<
	typeof jobs.$inferSelect,
	"job_type" | "project_id" | "environment_id" | "org_id" | "execution_metadata"
>;

/**
 * Runs the side effects of `job` (id `jobId`) ending FAILED with `errorMessage`. The caller has already
 * written `jobs.status = FAILED`. In order:
 *
 *  1. the `system.job.failed` alert, and `system.project.orphan_risk` when the runner flagged an
 *     interrupted apply;
 *  2. the environment through the env-status CAS — DEPLOY `deployFailed`, DESTROY `destroyFailed`,
 *     PLAN `planFailed` — plus the BYO IaC source's FAILED status for DEPLOY/DESTROY;
 *  3. the promotion this job backs, for DEPLOY and PLAN (`failPromotionForJob`; a no-op otherwise);
 *  4. a chart or IaC scan's result row (`finalizeChartScan` / `finalizeIacScan`).
 *
 * Best-effort throughout, as the status route was: each step logs its own error and never throws, so
 * one failing write does not skip the rest.
 */
export async function recordJobFailed(
	db: EnvStatusDb,
	jobId: string,
	job: FailedJob,
	errorMessage: string | null,
	jlog: Logger,
): Promise<void> {
	if (job.org_id) {
		const base = {
			job_id: jobId,
			job_type: job.job_type,
			project_id: job.project_id ?? undefined,
		};
		emitAlertEventSafe(job.org_id, "system.job.failed", {
			title: `Job failed: ${job.job_type}`,
			summary: errorMessage || undefined,
			severity: "critical",
			...base,
		});
		// A non-cancel mid-apply interruption the runner observed (its 2h deadline or a graceful
		// shutdown-drain) posts FAILED — not CANCELLED — but can still leave cloud resources outside
		// tofu state. When the runner flagged orphan risk, raise the SAME distinct critical alert the
		// cancel path raises so an operator reconciles cloud vs state. The env moves to FAILED via
		// deployFailed below, so no additional env-state change is needed here. (A hard SIGKILL/crash
		// mid-apply is not flagged by the runner; the server-side stale-job reconciler is the backstop.)
		if (job.execution_metadata?.orphan_risk === true) {
			emitAlertEventSafe(job.org_id, "system.project.orphan_risk", {
				title: "Possible orphaned resources after interrupted apply",
				summary:
					"An apply was interrupted mid-flight (timeout or runner shutdown); cloud resources may exist outside tofu state and need reconciliation.",
				severity: "critical",
				...base,
			});
		}
	}

	// M1: provisioning status lives on the targeted environment. Legacy / non-project jobs without one
	// skip it. Every env-status write goes through the CAS RPC (lib/db/env-status.ts), so a late or
	// racing writer cannot clobber a newer terminal state; a rejected transition is logged and alerted
	// inside transitionEnv and never throws.
	if (job.project_id && job.environment_id) {
		const environmentId = job.environment_id;
		const projectId = job.project_id;
		const move = (context: EnvTransitionContext) =>
			transitionEnv(db, environmentId, context, jobId, { orgId: job.org_id, projectId });
		const moveIac = () =>
			setIacSourceStatus(projectId, environmentId, "FAILED", errorMessage).catch((err) =>
				jlog.error("set iac source status", { err }),
			);
		if (job.job_type === "DEPLOY") {
			await move("deployFailed");
			await moveIac();
			// A promotion's deploy failed → mark the promotion FAILED (no-op otherwise).
			await failPromotionForJob(jobId).catch((err) =>
				jlog.error("fail promotion (deploy) error", { err }),
			);
		} else if (job.job_type === "DESTROY") {
			await move("destroyFailed");
			await moveIac();
		} else if (job.job_type === "PLAN") {
			await move("planFailed");
			await failPromotionForJob(jobId).catch((err) =>
				jlog.error("fail promotion (plan) error", { err }),
			);
		}
	}

	// CHART_SCAN / IAC_SCAN: write the failed scan back onto its chart / IaC source row.
	if (job.job_type === "CHART_SCAN") {
		await finalizeChartScan(jobId).catch((err) => jlog.error("finalize chart scan error", { err }));
	} else if (job.job_type === "IAC_SCAN") {
		await finalizeIacScan(jobId).catch((err) => jlog.error("finalize IaC scan error", { err }));
	}
}
