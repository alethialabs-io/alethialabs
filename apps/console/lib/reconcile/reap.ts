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

import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
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
		})
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.lifecycle, "ephemeral"),
				isNotNull(projectEnvironments.expires_at),
				lt(projectEnvironments.expires_at, now),
				inArray(projectEnvironments.status, [...REAPABLE_STATUSES]),
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
				await tx.insert(jobs).values({
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
				});
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
