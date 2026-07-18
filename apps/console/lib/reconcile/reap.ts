// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ephemeral-env reaper (activates the inert Env/Sandbox lifecycle — migration 0071, task #289). An
// ephemeral environment carries an `expires_at`; past it the reaper tears the env down by enqueuing a
// DESTROY, exactly as the console's own destroy flow does — but service-role (no session) and idempotent
// so it can safely run every tick under the supervised reconcile loop.
//
// This is a RECONCILER, not a fire-once cron:
//   • Idempotent — it only reaps envs still in a reapable settled state (ACTIVE / FAILED) that HAVE a
//     successful DEPLOY behind them (i.e. real live infra). The enqueue moves the env to QUEUED through
//     the CAS; a second pass sees QUEUED/DESTROYING/DESTROYED and skips it. Reaping an already-reaped env
//     is a no-op.
//   • Reconvergent on failure — a failed DESTROY settles the env back to FAILED (destroyFailed). The next
//     pass sees FAILED + expired and RETRIES the destroy. It never double-enqueues: while a destroy is in
//     flight the env is QUEUED/DESTROYING (out of the reapable set), so only a fully-settled FAILED env is
//     retried.
//   • Never resurrects a torn-down env — DESTROYED is not in the reapable set, and the enqueueDestroy CAS
//     from-set excludes it, so the terminal state is stable.
//
// Envs that expired but were never deployed (no successful DEPLOY → no infra) are left alone: there is
// nothing in the cloud to tear down, and a DESTROY with no state snapshot would just fail on the runner.
//
// BOUNDED RETRY (audit #10): a permanently-un-destroyable expired env used to be re-enqueued every 60s
// forever — a failed DESTROY settles the env back to FAILED (destroyFailed), `expires_at` is never
// bumped, so the next pass re-enqueued with zero backoff and no cap (log/ledger spam + wasted work). The
// reaper now tracks `reap_attempts` / `last_reap_at` on the env, applies exponential backoff between
// retries, and after MAX_REAP_ATTEMPTS stops re-enqueuing: it stamps `reap_gave_up_at` (dropping the env
// out of the reapable set), leaves it FAILED so it stays visible, and emits ONE operator alert asking for
// manual intervention. A fresh successful DEPLOY resets the counters (see finalizeDeployment).

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import type { Db } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import { jobs } from "@/lib/db/schema/jobs";
import { projectEnvironments } from "@/lib/db/schema/project-environments";
import { newTraceparent } from "@/lib/observability/trace";
import { log } from "@/lib/observability/log";
import { notifyScaler } from "@/lib/scaler";

const rlog = log.child({ component: "reconcile", reconciler: "ephemeral-reaper" });

/** Env statuses a reaper may tear down: settled states that still hold live infra. */
const REAPABLE_STATUSES = ["ACTIVE", "FAILED"] as const;

/**
 * Max consecutive DESTROY re-enqueue attempts before the reaper gives up on an env and flags it for
 * manual intervention. Tunable via ALETHIA_MAX_REAP_ATTEMPTS (default 6 → ~10m,20m,40m,80m,160m,320m).
 */
/** Parse the cap defensively: an unset/blank/NaN value → 6, and a non-positive misconfig (e.g. "-5"
 *  or "0") is clamped to at least 1 so an env is ALWAYS attempted at least once — a 0/negative cap
 *  would make decideReap give up on the first pass and leak every expired cluster (never destroyed). */
export const MAX_REAP_ATTEMPTS = (() => {
	const parsed = Math.trunc(Number(process.env.ALETHIA_MAX_REAP_ATTEMPTS));
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 6;
})();
/** Base backoff between reap retries; doubles per attempt up to the cap. */
const REAP_BACKOFF_BASE_MS = 5 * 60_000;
/** Upper bound on the backoff so a long-lived failing env still retries at least daily. */
const REAP_BACKOFF_CAP_MS = 24 * 60 * 60_000;

/**
 * Exponential backoff (capped) for the Nth reap attempt: BASE·2^attempts, clamped to the cap. With the
 * defaults: attempt 1 waits 10m, 2 → 20m, 3 → 40m … capped at 24h.
 */
export function reapBackoffMs(attempts: number): number {
	return Math.min(REAP_BACKOFF_BASE_MS * 2 ** attempts, REAP_BACKOFF_CAP_MS);
}

/** The reaper's per-env decision: enqueue a fresh DESTROY, wait out the backoff, or give up. */
export type ReapDecision = "reap" | "backoff" | "give_up";

/**
 * Pure decision for a single expired, infra-bearing env: should the reaper re-enqueue its DESTROY now,
 * skip this pass (backoff not elapsed), or give up (attempt cap hit)? Keeping it pure makes the
 * "stop looping" behaviour provable without a database. First attempt (attempts=0, lastReapAt=null) →
 * "reap" immediately; after each attempt the caller must have stamped attempts+1 and lastReapAt=now.
 */
export function decideReap(
	attempts: number,
	lastReapAt: Date | null,
	now: Date,
): ReapDecision {
	if (attempts >= MAX_REAP_ATTEMPTS) return "give_up";
	if (lastReapAt && now.getTime() - lastReapAt.getTime() < reapBackoffMs(attempts)) {
		return "backoff";
	}
	return "reap";
}

/**
 * Reap expired ephemeral environments by enqueuing their DESTROY. Best-effort per env; one env's
 * enqueue failing never blocks the rest. Returns how many DESTROY jobs were enqueued this pass.
 */
export async function reapExpiredEphemeralEnvs(
	db: Db,
	now: Date = new Date(),
): Promise<{ reaped: number; expired: number }> {
	// Expired ephemeral envs still in a reapable (settled, infra-bearing) status.
	const expiredEnvs = await db
		.select({
			id: projectEnvironments.id,
			user_id: projectEnvironments.user_id,
			org_id: projectEnvironments.org_id,
			project_id: projectEnvironments.project_id,
			name: projectEnvironments.name,
			expires_at: projectEnvironments.expires_at,
			reap_attempts: projectEnvironments.reap_attempts,
			last_reap_at: projectEnvironments.last_reap_at,
		})
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.lifecycle, "ephemeral"),
				isNotNull(projectEnvironments.expires_at),
				lt(projectEnvironments.expires_at, now),
				inArray(projectEnvironments.status, [...REAPABLE_STATUSES]),
				// Envs the reaper already gave up on drop out of the set permanently (until a fresh
				// successful DEPLOY clears reap_gave_up_at) — no infinite re-enqueue, no alert storm.
				isNull(projectEnvironments.reap_gave_up_at),
			),
		);
	if (expiredEnvs.length === 0) return { reaped: 0, expired: 0 };

	// The teardown reuses the env's last successful DEPLOY snapshot (its provisioned state key +
	// cloud identity) — the exact infra to destroy. An env with no successful deploy has no infra and
	// is filtered out here.
	const envIds = expiredEnvs.map((e) => e.id);
	const deployRows = await db
		.select({
			environment_id: jobs.environment_id,
			config_snapshot: jobs.config_snapshot,
			cloud_identity_id: jobs.cloud_identity_id,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.job_type, "DEPLOY"),
				eq(jobs.status, "SUCCESS"),
				inArray(jobs.environment_id, envIds),
			),
		)
		.orderBy(desc(jobs.created_at));
	const lastDeployByEnv = new Map<string, (typeof deployRows)[number]>();
	for (const r of deployRows) {
		if (r.environment_id && !lastDeployByEnv.has(r.environment_id)) {
			lastDeployByEnv.set(r.environment_id, r);
		}
	}

	let reaped = 0;
	for (const env of expiredEnvs) {
		const lastDeploy = lastDeployByEnv.get(env.id);
		if (!lastDeploy) continue; // never deployed → no infra to reap

		const decision = decideReap(env.reap_attempts, env.last_reap_at, now);

		// Attempt cap hit: stop re-enqueuing. Stamp reap_gave_up_at (a single atomic UPDATE) so the
		// isNull predicate excludes this env on every future pass, leave it FAILED so it stays visible,
		// and raise ONE operator alert. Fires exactly once — the next pass no longer selects it.
		if (decision === "give_up") {
			try {
				await db
					.update(projectEnvironments)
					.set({ reap_gave_up_at: now })
					.where(eq(projectEnvironments.id, env.id));
				rlog.error("ephemeral reap gave up after max attempts — manual teardown needed", {
					env_id: env.id,
					env_name: env.name,
					project_id: env.project_id ?? undefined,
					org_id: env.org_id ?? undefined,
					reap_attempts: env.reap_attempts,
					max_reap_attempts: MAX_REAP_ATTEMPTS,
				});
				if (env.org_id) {
					emitAlertEventSafe(env.org_id, "system.project.reap_gave_up", {
						title: "Auto-teardown gave up",
						summary: `Environment "${env.name}" could not be torn down after ${MAX_REAP_ATTEMPTS} attempts and needs manual intervention.`,
						severity: "critical",
						resource_type: "project",
						resource_id: env.id,
						project_id: env.project_id ?? undefined,
					});
				}
			} catch (err) {
				rlog.error("ephemeral reap give-up stamp failed", { err, env_id: env.id });
			}
			continue;
		}

		// Backoff not elapsed since the last (failed) teardown enqueue: skip silently this pass.
		if (decision === "backoff") continue;

		try {
			// Atomic enqueue: CAS (env → QUEUED via enqueueDestroy) + DESTROY job insert in one tx, so a
			// failed insert can't leave the env stuck QUEUED with no destroy behind it. The CAS runs
			// first: if the env moved out of the reapable set between the SELECT and here (another reaper
			// pass / a user teardown), it loses the race and the tx enqueues nothing.
			const enqueued = await db.transaction(async (tx) => {
				const moved = await transitionEnv(tx, env.id, "enqueueDestroy", null, {
					orgId: env.org_id,
					projectId: env.project_id,
				});
				if (!moved) return false;
				await tx.insert(jobs).values(signedJob({
					user_id: env.user_id,
					org_id: env.org_id ?? undefined,
					project_id: env.project_id,
					environment_id: env.id,
					cloud_identity_id: lastDeploy.cloud_identity_id,
					job_type: "DESTROY",
					config_snapshot: lastDeploy.config_snapshot,
					status: "QUEUED",
					// A reap teardown is a fresh operation → a new trace root.
					traceparent: newTraceparent(),
				}));
				// Charge the attempt in the same tx as the enqueue: reap_attempts+1 gates the give-up
				// cap, last_reap_at=now arms the backoff clock for the next pass. If this DESTROY fails
				// (env settles back to FAILED), the next reap will wait reapBackoffMs(reap_attempts).
				await tx
					.update(projectEnvironments)
					.set({
						reap_attempts: sql`${projectEnvironments.reap_attempts} + 1`,
						last_reap_at: now,
					})
					.where(eq(projectEnvironments.id, env.id));
				return true;
			});
			if (!enqueued) continue;
			reaped += 1;
			rlog.info("reaped expired ephemeral env (enqueued DESTROY)", {
				env_id: env.id,
				env_name: env.name,
				project_id: env.project_id ?? undefined,
				org_id: env.org_id ?? undefined,
				expired_at: env.expires_at?.toISOString(),
			});
			if (env.org_id) {
				emitAlertEventSafe(env.org_id, "system.job.destroy_requested", {
					title: "Ephemeral environment expired — tearing down",
					summary: `Environment "${env.name}" passed its expiry and is being destroyed automatically.`,
					severity: "warning",
					resource_type: "project",
					resource_id: env.id,
					project_id: env.project_id ?? undefined,
				});
			}
		} catch (err) {
			rlog.error("ephemeral reap enqueue failed", { err, env_id: env.id });
		}
	}
	if (reaped > 0) notifyScaler();
	return { reaped, expired: expiredEnvs.length };
}
