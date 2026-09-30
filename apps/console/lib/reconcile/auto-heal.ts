// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 auto-heal: re-applies an environment's LAST DEPLOYED design after a DETECT_DRIFT job found it
// out of sync. It NEVER ships pending config edits — only the frozen snapshot of the last successful
// DEPLOY. Opt-in per environment, production is always approval-gated, and backoff plus a
// circuit breaker bound the retries.
//
// This lives in lib/, NOT in app/server/actions/reconcile.ts: it is service-role, takes no session,
// and ENQUEUES A DEPLOY. Inside a `"use server"` file every export is a public POST-addressable
// Server Action, so anyone holding an environment id could trigger a re-apply of real cloud
// infrastructure (#5219). Its only caller is the runner-facing job-status route, which has already
// verified the runner token.
//
// Do not add `"use server"` here.

import { and, desc, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import { jobs, projectEnvironments } from "@/lib/db/schema";
import { signedJob } from "@/lib/db/signed-job";
import { newTraceparent } from "@/lib/observability/trace";
import { notifyScaler } from "@/lib/scaler";

/** Circuit breaker: stop auto-healing an env after this many consecutive failed deploys. */
const MAX_AUTO_HEAL_FAILURES = 3;
/** Backoff base (minutes); the wait grows 2^failures, capped at MAX_BACKOFF_MIN. */
const BACKOFF_BASE_MIN = 5;
const MAX_BACKOFF_MIN = 60;

/**
 * Considers auto-healing an environment after a DETECT_DRIFT job reported it out of sync. Service role
 * (no session). Re-applies the env's LAST DEPLOYED design (the most recent successful DEPLOY snapshot)
 * to restore state. Guarded: opt-in only, prod is skipped (approval-gated), no concurrent apply,
 * exponential backoff, and a circuit breaker.
 */
export async function maybeAutoHeal(
	projectId: string,
	environmentId: string,
): Promise<void> {
	const db = getServiceDb();
	const [env] = await db
		.select()
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, environmentId))
		.limit(1);
	if (!env || !env.auto_heal) return;
	// Production is always approval-gated — surface the drift, never auto-apply.
	if (env.stage === "production") return;
	// Never apply while another job is touching this env's state (one tofu apply per state), and
	// never resurrect a deliberately torn-down env (DESTROYED). The enqueueAutoHeal CAS below
	// enforces the same from-set; this early-out just avoids the wasted last-deploy lookup.
	if (["QUEUED", "PROVISIONING", "DESTROYING", "DESTROYED"].includes(env.status))
		return;
	// Circuit breaker: stop retrying after repeated failures (drift is still surfaced for a human).
	if (env.auto_heal_failures >= MAX_AUTO_HEAL_FAILURES) return;
	// Exponential backoff since the last auto-heal attempt.
	if (env.last_auto_heal_at) {
		const waitMin = Math.min(
			BACKOFF_BASE_MIN * 2 ** env.auto_heal_failures,
			MAX_BACKOFF_MIN,
		);
		const elapsedMin = (Date.now() - env.last_auto_heal_at.getTime()) / 60_000;
		if (elapsedMin < waitMin) return;
	}

	// Re-apply the exact last-deployed design (its frozen snapshot). Nothing deployed yet → nothing
	// to restore.
	const [lastDeploy] = await db
		.select({
			config_snapshot: jobs.config_snapshot,
			cloud_identity_id: jobs.cloud_identity_id,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, environmentId),
				eq(jobs.job_type, "DEPLOY"),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);
	if (!lastDeploy) return;

	// Enqueue atomically: the env-status CAS (env → QUEUED), the heal-timestamp bump, and the DEPLOY
	// job insert are ONE transaction. Previously these ran as three separate statements on the service
	// Db, so a failure of the job insert AFTER the CAS had already moved the env to QUEUED left the env
	// stuck QUEUED with no job behind it (an orphaned in-flight state the scaler would never clear).
	// Wrapping them means either all three land or none do — the CAS rolls back with the insert.
	//
	// The CAS runs FIRST inside the tx so a lost race (a concurrent transition moved the env out of a
	// healable state between the guard SELECT above and here) aborts before we queue an orphan auto-heal
	// job that would deploy onto a torn-down / in-flight env.
	const enqueued = await db.transaction(async (tx) => {
		const moved = await transitionEnv(tx, environmentId, "enqueueAutoHeal", null, {
			orgId: env.org_id,
			projectId,
		});
		if (!moved) return false;
		await tx
			.update(projectEnvironments)
			.set({ last_auto_heal_at: new Date() })
			.where(eq(projectEnvironments.id, environmentId));
		await tx.insert(jobs).values(signedJob({
			user_id: env.user_id,
			org_id: env.org_id ?? undefined,
			project_id: projectId,
			environment_id: environmentId,
			cloud_identity_id: lastDeploy.cloud_identity_id,
			job_type: "DEPLOY",
			config_snapshot: lastDeploy.config_snapshot,
			status: "QUEUED",
			// An auto-heal re-apply is a fresh operation → a new trace root.
			traceparent: newTraceparent(),
		}));
		return true;
	});
	// Only wake the scaler once the whole enqueue committed (a rolled-back tx queued nothing).
	if (enqueued) notifyScaler();
}
