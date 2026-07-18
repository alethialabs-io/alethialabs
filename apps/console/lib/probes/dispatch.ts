// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema/jobs";
import { projectEnvironments } from "@/lib/db/schema/project-environments";
import {
	type ProbeCandidate,
	selectDueForProbe,
	tierForStage,
} from "@/lib/probes/schedule";
import { notifyScaler } from "@/lib/scaler";

/**
 * Enqueue PROBE_CLUSTER jobs for every ACTIVE environment whose last liveness probe is older
 * than its tier cadence (BYOC B2). Runs at service level (no user session) — hosted on the
 * reconcile loop's `probe-schedule` reconciler (lib/reconcile/loop.ts). This is a faithful
 * clone of the drift sweeper (lib/drift/dispatch.ts sweepDriftSchedule): same snapshot source
 * (the env's latest successful DEPLOY, so the runner's RunProbe reads the exact provisioned
 * state to find the cluster), same anti-stampede exclusion of in-flight probes, same
 * per-env-cadence selection — only the cadence (PROBE_CADENCE_MS) and the job_type differ.
 *
 * Two ways this differs deliberately from drift dispatch:
 *   1. It probes ONLY envs whose status is ACTIVE — a DRAFT/DESTROYED/FAILED env has no live
 *      cluster to dial, and probing one would spuriously report unreachable=false (and could
 *      page). Drift keys purely off "has a successful DEPLOY"; liveness additionally needs the
 *      cluster to currently be expected-up.
 *   2. There is NO cross-replica partial-unique-index dedup (drift's uq_jobs_active_drift_per_env
 *      + onConflictDoNothing). Adding one is a schema migration, out of scope for B2.3 (B2.1
 *      owns the probe schema). The in-flight exclusion below is drift's FIRST dedup layer and
 *      covers the common cases (same replica, and any later tick while a probe is still running,
 *      since the cadence keys off the latest probe job regardless of status). A probe is a cheap,
 *      idempotent, read-only dial that appends one history row — so the residual window (two
 *      replicas inserting in the same instant) at worst writes one redundant probe, which is
 *      harmless, unlike a duplicate tofu-running drift. Add the unique index if that ever matters.
 */
export async function sweepProbeSchedule(
	now: Date = new Date(),
): Promise<{ enqueued: number }> {
	const db = getServiceDb();

	// Latest successful DEPLOY per environment — the state-locating snapshot source. Only envs
	// with a successful deploy have a cluster whose state a probe can read.
	const deployRows = await db
		.select({
			environment_id: jobs.environment_id,
			project_id: jobs.project_id,
			user_id: jobs.user_id,
			cloud_identity_id: jobs.cloud_identity_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(and(eq(jobs.job_type, "DEPLOY"), eq(jobs.status, "SUCCESS")))
		.orderBy(desc(jobs.created_at));

	const latestDeployByEnv = new Map<string, (typeof deployRows)[number]>();
	for (const r of deployRows) {
		if (r.environment_id && !latestDeployByEnv.has(r.environment_id)) {
			latestDeployByEnv.set(r.environment_id, r);
		}
	}
	const deployedEnvIds = [...latestDeployByEnv.keys()];
	if (deployedEnvIds.length === 0) return { enqueued: 0 };

	// Restrict to ACTIVE envs (a live cluster to probe) + read each env's stage for its tier.
	const envRows = await db
		.select({
			id: projectEnvironments.id,
			stage: projectEnvironments.stage,
			status: projectEnvironments.status,
		})
		.from(projectEnvironments)
		.where(inArray(projectEnvironments.id, deployedEnvIds));
	const stageById = new Map(envRows.map((e) => [e.id, e.stage]));
	const activeEnvIds = envRows
		.filter((e) => e.status === "ACTIVE")
		.map((e) => e.id);
	if (activeEnvIds.length === 0) return { enqueued: 0 };

	// Latest PROBE_CLUSTER per environment — when each was last probed (any status; a still-running
	// probe counts, so the cadence doesn't re-fire while one is in flight).
	const probeRows = await db
		.select({
			environment_id: jobs.environment_id,
			created_at: jobs.created_at,
		})
		.from(jobs)
		.where(eq(jobs.job_type, "PROBE_CLUSTER"))
		.orderBy(desc(jobs.created_at));
	const lastProbeByEnv = new Map<string, Date>();
	for (const r of probeRows) {
		if (r.environment_id && !lastProbeByEnv.has(r.environment_id)) {
			lastProbeByEnv.set(r.environment_id, r.created_at);
		}
	}

	// Anti-stampede: an env with a PROBE_CLUSTER job still in flight (QUEUED/CLAIMED/PROCESSING)
	// must NOT get a second one — a slow/stuck runner would otherwise pile up duplicates each pass.
	const inFlightProbeRows = await db
		.select({ environment_id: jobs.environment_id })
		.from(jobs)
		.where(
			and(
				eq(jobs.job_type, "PROBE_CLUSTER"),
				inArray(jobs.status, ["QUEUED", "CLAIMED", "PROCESSING"]),
				inArray(jobs.environment_id, activeEnvIds),
			),
		);
	const inFlightProbeEnvs = new Set(
		inFlightProbeRows
			.map((r) => r.environment_id)
			.filter((id): id is string => id !== null),
	);

	const candidates: ProbeCandidate[] = activeEnvIds
		.filter((id) => !inFlightProbeEnvs.has(id))
		.map((id) => ({
			environmentId: id,
			projectId: latestDeployByEnv.get(id)?.project_id ?? "",
			tier: tierForStage(stageById.get(id)),
			lastCheckedAt: lastProbeByEnv.get(id) ?? null,
		}));

	const due = selectDueForProbe(candidates, now);

	let enqueued = 0;
	for (const c of due) {
		const src = latestDeployByEnv.get(c.environmentId);
		if (!src) continue;
		await db.insert(jobs).values(signedJob({
			user_id: src.user_id,
			project_id: src.project_id,
			environment_id: c.environmentId,
			cloud_identity_id: src.cloud_identity_id,
			job_type: "PROBE_CLUSTER",
			config_snapshot: src.config_snapshot,
			status: "QUEUED",
		}));
		enqueued++;
	}
	if (enqueued > 0) notifyScaler();
	return { enqueued };
}
