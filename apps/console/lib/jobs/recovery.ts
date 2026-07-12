// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import {
	type EnvTransitionContext,
	transitionEnv,
} from "@/lib/db/env-status";
import type { ProvisionJobType } from "@/lib/db/schema/enums";
import { log } from "@/lib/observability/log";

const rlog = log.child({ component: "job-recovery" });

/** A runner flipped to OFFLINE by the sweep (the durable alert signal). */
type SweptRunner = {
	runner_id: string;
	org_id: string | null;
	runner_name: string;
};

/** A job recover_stale_jobs failed TERMINAL at the poison-job cap (its env needs reconciling). */
type FailedStaleJob = {
	job_id: string;
	job_type: ProvisionJobType;
	environment_id: string | null;
	org_id: string | null;
	project_id: string | null;
};

/** Map a terminally-failed provisioning job to the env-status CAS context that moves its env to
 *  FAILED. Only DEPLOY/DESTROY/PLAN own an env lifecycle status; other job types return null. */
function envFailContextFor(
	jobType: ProvisionJobType,
): EnvTransitionContext | null {
	switch (jobType) {
		case "DEPLOY":
			return "deployFailed";
		case "DESTROY":
			return "destroyFailed";
		case "PLAN":
			return "planFailed";
		default:
			return null;
	}
}

/**
 * Requeue stale jobs (dead-runner or stalled-but-alive) and, for any the poison-job cap failed
 * TERMINAL, reconcile downstream state: route the env to FAILED through the env-status CAS
 * (transitionEnv — never clobbers a newer terminal state, never throws) and emit a job-failed
 * alert so the operator sees a job that gave up. Best-effort per row; one failure never blocks
 * the rest. All writes go through getServiceDb (RLS-bypassing; the fleet/recovery loops are global).
 */
export async function recoverStaleJobs(db: ReturnType<typeof getServiceDb>): Promise<void> {
	const failed = await db.execute<FailedStaleJob>(
		sql`select * from recover_stale_jobs()`,
	);
	for (const j of failed) {
		const ctx = envFailContextFor(j.job_type);
		if (ctx && j.environment_id) {
			await transitionEnv(db, j.environment_id, ctx, j.job_id, {
				orgId: j.org_id,
				projectId: j.project_id,
			}).catch((err) =>
				rlog.error("env FAILED on poison-cap error", { err, job_id: j.job_id }),
			);
		}
		if (j.org_id) {
			emitAlertEventSafe(j.org_id, "system.job.failed", {
				title: `Job failed: ${j.job_type}`,
				summary:
					"The job exceeded its max attempts (its runner repeatedly died or stalled) and was failed by the poison-job cap.",
				severity: "critical",
				job_id: j.job_id,
				job_type: j.job_type,
				project_id: j.project_id ?? undefined,
			});
		}
	}
}

// In-app replacement for the AWS-Lambda cron that requeued stale jobs. Each app
// instance runs the interval; recover_stale_jobs() is idempotent (FOR UPDATE
// SKIP LOCKED semantics make concurrent runs across instances safe), so the
// self-host bundle needs no Lambda. See dataroom/spec/mvp/06-self-hosting-architecture.md.

const RECOVERY_INTERVAL_MS = 60_000;

/** Hours a never-saved pending identity lingers before it's garbage-collected. */
const PENDING_IDENTITY_TTL_H = Number(
	process.env.ALETHIA_PENDING_IDENTITY_TTL_H ?? "24",
);

const globalForRecovery = globalThis as unknown as {
	__alethiaJobRecovery?: ReturnType<typeof setInterval>;
};

/**
 * Starts the periodic stale-job recovery + offline-runner sweep (idempotent
 * across HMR/instances). sweep_offline_runners() flips dead runners to OFFLINE
 * and closes their open usage sessions (managed-runner metering).
 */
export function startStaleJobRecovery(): void {
	if (globalForRecovery.__alethiaJobRecovery) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	globalForRecovery.__alethiaJobRecovery = setInterval(() => {
		const db = getServiceDb();
		void recoverStaleJobs(db).catch((err) => {
			rlog.error("recover_stale_jobs failed", { err });
		});
		// GC never-saved pending identities. Best-effort.
		void db
			.execute(
				sql`select gc_pending_identities(make_interval(hours => ${PENDING_IDENTITY_TTL_H}))`,
			)
			.catch((err) => {
				rlog.error("gc_pending_identities failed", { err });
			});
		void db
			.execute<SweptRunner>(sql`select * from sweep_offline_runners()`)
			.then((rows) => {
				// Emit a `system.runner.offline` alert per flipped runner (best-effort;
				// the rule throttle collapses repeats if instances race).
				for (const r of rows) {
					if (!r.org_id) continue;
					emitAlertEventSafe(r.org_id, "system.runner.offline", {
						title: `Runner offline: ${r.runner_name}`,
						severity: "warning",
						resource_type: "runner",
						resource_id: r.runner_id,
					});
				}
			})
			.catch((err) => {
				rlog.error("sweep_offline_runners failed", { err });
			});
	}, RECOVERY_INTERVAL_MS);
}
