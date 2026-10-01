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
import {
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";
import { log } from "@/lib/observability/log";

const rlog = log.child({ component: "job-recovery" });

/** A runner flipped to OFFLINE by the sweep (the durable alert signal). */
type SweptRunner = {
	runner_id: string;
	org_id: string | null;
	runner_name: string;
};

/**
 * Why recover_stale_jobs failed a job terminally instead of requeueing it: `max_attempts` is the
 * poison-job cap; `apply_started` is a job whose runner had reported the apply started, which is
 * never requeued because a retry would apply a second time (#5162).
 */
type StaleFailReason = "max_attempts" | "apply_started";

/** A job recover_stale_jobs failed TERMINAL (its env needs reconciling). */
type FailedStaleJob = {
	job_id: string;
	job_type: ProvisionJobType;
	environment_id: string | null;
	org_id: string | null;
	project_id: string | null;
	reason: StaleFailReason;
};

/** The alert summary for a terminally-failed stale job — it has to say which rule fired, because the
 *  two ask the operator for different things (a stuck queue vs. an environment to reconcile). */
function staleFailSummary(reason: StaleFailReason): string {
	switch (reason) {
		case "apply_started":
			return "The runner lost contact after the apply had started. The job was not retried, because a retry would apply a second time. Check the environment and reconcile it before deploying again.";
		case "max_attempts":
			return "The job exceeded its max attempts (its runner repeatedly died or stalled) and was failed by the poison-job cap.";
	}
}

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
 * Requeue stale jobs (dead-runner or stalled-but-alive) and, for any failed TERMINAL — by the
 * poison-job cap, or because the apply had already started (never requeued, #5162) — reconcile
 * downstream state: route the env to FAILED through the env-status CAS
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
				rlog.error("env FAILED on stale-job terminal error", {
					err,
					job_id: j.job_id,
					reason: j.reason,
				}),
			);
		}
		if (j.org_id) {
			emitAlertEventSafe(j.org_id, "system.job.failed", {
				title: `Job failed: ${j.job_type}`,
				summary: staleFailSummary(j.reason),
				severity: "critical",
				job_id: j.job_id,
				job_type: j.job_type,
				project_id: j.project_id ?? undefined,
			});
		}
	}
}

// In-app replacement for the AWS-Lambda cron that requeued stale jobs. Each app
// instance runs the interval; recover_stale_jobs() is safe under concurrent runs
// across instances — it's a plain UPDATE over CLAIMED/PROCESSING rows (disjoint from
// claim_next_job's QUEUED set), and the row-lock + READ COMMITTED re-check (EvalPlanQual)
// collapse two concurrent recoveries of the same row to a single requeue. So the
// self-host bundle needs no Lambda. See dataroom/spec/mvp/06-self-hosting-architecture.md.
//
// A requeue never re-runs an apply that STARTED (#5162): the runner posts `apply_started_at` the
// moment its stage reaches `tofu apply`, and recover_stale_jobs fails such a job for
// reconciliation instead of requeueing it — whether the runner is dead, or merely partitioned
// while still applying (a heartbeat gap, a >30-min log-ingest partition). What remains is the
// window before that post LANDS: the runner polls its phase marker once a second and retries a
// failed post every tick, so a job that goes stale in that window with the post never having
// landed is still requeued. If its runner was alive, its next post is refused (409), and it stops
// the apply rather than race the new claim; the tofu state lock guards the rest.

const RECOVERY_INTERVAL_MS = 60_000;

/** Hours a never-saved pending identity lingers before it's garbage-collected. */
const PENDING_IDENTITY_TTL_H = Number(
	process.env.ALETHIA_PENDING_IDENTITY_TTL_H ?? "24",
);

declare global {
	var __alethiaJobRecovery: ReturnType<typeof setInterval> | undefined;
}

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const RECOVERY_LOOP_ID = "job-recovery";

/**
 * One supervised recovery pass: stale-job requeue, pending-identity GC, and the offline-runner sweep.
 * The three are independent + best-effort, so they run under `allSettled` (one failing never blocks the
 * others); if any rejected, the pass throws an aggregate so the loop's heartbeat records the failure
 * (→ DEGRADED after the threshold) rather than silently swallowing it.
 */
export async function runRecoveryTick(
	db: ReturnType<typeof getServiceDb> = getServiceDb(),
): Promise<void> {
	const results = await Promise.allSettled([
		recoverStaleJobs(db),
		// GC never-saved pending identities.
		db.execute(
			sql`select gc_pending_identities(make_interval(hours => ${PENDING_IDENTITY_TTL_H}))`,
		),
		// sweep_offline_runners() flips dead runners to OFFLINE + closes their usage sessions.
		db
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
			}),
	]);
	const failed = results.filter((r) => r.status === "rejected");
	if (failed.length > 0) {
		for (const f of failed) rlog.error("recovery sub-task failed", { err: f.reason });
		throw new Error(
			`recovery tick: ${failed.length}/${results.length} sub-tasks failed`,
		);
	}
}

/**
 * Starts the periodic stale-job recovery + offline-runner sweep (idempotent
 * across HMR/instances). sweep_offline_runners() flips dead runners to OFFLINE
 * and closes their open usage sessions (managed-runner metering). Each tick is
 * heartbeat-supervised (lib/observability/heartbeats.ts) so /health can see it ticking.
 */
export function startStaleJobRecovery(): void {
	if (globalThis.__alethiaJobRecovery) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(RECOVERY_LOOP_ID, { intervalMs: RECOVERY_INTERVAL_MS });
	globalThis.__alethiaJobRecovery = setInterval(() => {
		void superviseLoop(RECOVERY_LOOP_ID, () => runRecoveryTick());
	}, RECOVERY_INTERVAL_MS);
}
