"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 reconcile (Phase 3). Two divergence signals for an environment:
//   • cloud drift — live infra ≠ recorded state (DETECT_DRIFT refresh-only plan → environment_drift)
//   • config-vs-desired — the design moved ahead of what's deployed (structuralHash vs deployed_config_hash)
// maybeAutoHeal (service role, called from the job-status route on a non-in-sync DETECT_DRIFT) re-applies
// the LAST DEPLOYED design to restore state for opt-in envs. It NEVER ships pending config edits, and
// production is always approval-gated. getEnvReconcileStates powers the console's per-env badges.

import { and, desc, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import { environmentDrift, jobs, projectEnvironments } from "@/lib/db/schema";
import { newTraceparent } from "@/lib/observability/trace";
import { structuralHash } from "@/lib/promotions/diff";
import { notifyScaler } from "@/lib/scaler";
import { getLatestProbesByEnv } from "./probes";
import { getProjectAsFormData } from "./projects";

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
		await tx.insert(jobs).values({
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
		});
		return true;
	});
	// Only wake the scaler once the whole enqueue committed (a rolled-back tx queued nothing).
	if (enqueued) notifyScaler();
}

/** The latest cluster-alive probe facet of an env's reconcile state (BYOC B2). */
export interface EnvProbeState {
	/** True = API server answered, false = unreachable, null = never probed. */
	reachable: boolean | null;
	/** Short human-readable summary (esp. WHY unreachable). */
	message: string | null;
	/** When the last probe ran (RFC3339), null when never probed. */
	probedAt: string | null;
}

/** Per-environment reconcile state for the console's stability badges. */
export interface EnvReconcileState {
	environmentId: string;
	autoHeal: boolean;
	/** Latest cloud-drift posture: true = in sync, false = drifted, null = never scanned. */
	driftInSync: boolean | null;
	/** True when the env's designed structure has moved ahead of what's deployed. */
	deployPending: boolean;
	lastDeployedAt: string | null;
	/**
	 * Latest cluster-alive signal (BYOC B2). `reachable` null = never probed. The console badge
	 * pairs this with drift: drift answers "has it diverged?", probe answers "is it still up?".
	 */
	probe: EnvProbeState;
}

/** The reconcile state of every environment in a project (drift + config-vs-desired + auto-heal). */
export async function getEnvReconcileStates(
	projectId: string,
): Promise<EnvReconcileState[]> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envs = await withOwnerScope(actor.userId, (tx) =>
		tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId)),
	);

	// Latest cluster-alive probe per env (BYOC B2), fetched once for the project (org-scoped join
	// inside). Envs never probed are simply absent → the badge shows null (never probed).
	const probesByEnv = await getLatestProbesByEnv(projectId, actor.orgId);

	return Promise.all(
		envs.map(async (env) => {
			const db = getServiceDb();
			const [drift] = await db
				.select({ in_sync: environmentDrift.in_sync })
				.from(environmentDrift)
				.where(eq(environmentDrift.environment_id, env.id))
				.orderBy(desc(environmentDrift.scanned_at))
				.limit(1);
			// config-vs-desired: hash the current design and compare to what was last deployed.
			// Reading the design can throw (e.g. a since-deleted cloud identity); degrade that env
			// to "not pending" rather than failing the whole project's reconcile view.
			let deployPending = false;
			if (env.deployed_config_hash) {
				try {
					const design = (await getProjectAsFormData(projectId, env.id)).formData;
					deployPending = structuralHash(design) !== env.deployed_config_hash;
				} catch {
					deployPending = false;
				}
			}
			const probe = probesByEnv.get(env.id);
			return {
				environmentId: env.id,
				autoHeal: env.auto_heal,
				driftInSync: drift ? drift.in_sync : null,
				deployPending,
				lastDeployedAt: env.last_deployed_at?.toISOString() ?? null,
				probe: {
					reachable: probe ? probe.reachable : null,
					message: probe ? probe.message : null,
					probedAt: probe ? probe.probedAt : null,
				},
			};
		}),
	);
}
