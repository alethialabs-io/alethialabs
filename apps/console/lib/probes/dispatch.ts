// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { getServiceDb } from "@/lib/db";
import { dbNow } from "@/lib/db/now";
import { jobs } from "@/lib/db/schema/jobs";
import { projectCluster } from "@/lib/db/schema/project-components";
import { projectEnvironments } from "@/lib/db/schema/project-environments";
import {
	countLeadingMisses,
	type ProbeCandidate,
	selectDueForProbe,
	tierForStage,
} from "@/lib/probes/schedule";
import { notifyScaler } from "@/lib/scaler";

/** Env statuses a probe never runs for: torn down, or being torn down. */
const NEVER_PROBED: ReadonlySet<string> = new Set(["DESTROYED", "DESTROYING"]);

/**
 * Whether an env is believed to hold a cluster a probe can dial (#6736). The caller has already
 * required a successful DEPLOY behind it. An ACTIVE env is probed exactly as before. Any other env
 * must also still carry its deploy stamp (a successful DESTROY clears it), must not be torn down
 * or tearing down, and must not have a cluster row that says DESTROYED.
 */
function probeEligible(e: {
	status: string;
	last_deployed_at: Date | null;
	cluster_status: string | null;
}): boolean {
	if (e.status === "ACTIVE") return true;
	return e.last_deployed_at !== null && !NEVER_PROBED.has(e.status) && e.cluster_status !== "DESTROYED";
}

/**
 * Enqueue PROBE_CLUSTER jobs for every environment believed to hold a cluster whose last liveness
 * probe is older than its cadence (BYOC B2; widened by #6736). Runs at service level (no user session) — hosted on the
 * reconcile loop's `probe-schedule` reconciler (lib/reconcile/loop.ts). This is a faithful
 * clone of the drift sweeper (lib/drift/dispatch.ts sweepDriftSchedule): same snapshot source
 * (the env's latest successful DEPLOY, so the runner's RunProbe reads the exact provisioned
 * state to find the cluster), same anti-stampede exclusion of in-flight probes, same
 * per-env-cadence selection — only the cadence (PROBE_CADENCE_MS) and the job_type differ.
 *
 * Two ways this differs deliberately from drift dispatch:
 *   1. It probes only envs BELIEVED TO HOLD A CLUSTER: a successful DEPLOY behind it, a deploy
 *      stamp still set (a successful DESTROY clears it), its cluster row not DESTROYED, and its
 *      own status not DESTROYED or DESTROYING (a teardown in flight is expected to go dark).
 *      It used to probe ACTIVE only, which meant an env stranded in flight (#6736 — four months
 *      PROVISIONING) or FAILED lost its liveness signal exactly when it was most needed. A
 *      non-ACTIVE env is probed at its tier cadence, never tighter, backed off on consecutive
 *      misses (probeCadenceMs), and its true→false transition does not page
 *      (app/api/jobs/[id]/status/route.ts) — the card says Unreachable or Missing instead.
 *   2. There is NO cross-replica partial-unique-index dedup (drift's uq_jobs_active_drift_per_env
 *      + onConflictDoNothing). Adding one is a schema migration, out of scope for B2.3 (B2.1
 *      owns the probe schema). The in-flight exclusion below is drift's FIRST dedup layer and
 *      covers the common cases (same replica, and any later tick while a probe is still running,
 *      since the cadence keys off the latest probe job regardless of status). A probe is a cheap,
 *      idempotent, read-only dial that appends one history row — so the residual window (two
 *      replicas inserting in the same instant) at worst writes one redundant probe, which is
 *      harmless, unlike a duplicate tofu-running drift. Add the unique index if that ever matters.
 *
 * `now` is the clock the cadence is measured against — same contract as the drift sweeper. Leave it
 * unset in production so the sweep reads the DATABASE's clock, the one that stamped the `created_at`
 * timestamps it compares. Pass it only from a test, which must then also control those timestamps.
 */
export async function sweepProbeSchedule(now?: Date): Promise<{ enqueued: number }> {
	const db = getServiceDb();
	// One clock, and it is the database's — see lib/db/now.ts and the drift sweeper for why the
	// application must not write `jobs.created_at` and therefore must not measure against its own.
	const at = now ?? (await dbNow(db));

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

	// Restrict to envs believed to hold a cluster (see the header) + read each env's stage for its
	// tier. The cluster row is a LEFT join: an env whose design has no cluster row still has the
	// state the probe reads, and only a row that says DESTROYED rules it out.
	const envRows = await db
		.select({
			id: projectEnvironments.id,
			stage: projectEnvironments.stage,
			status: projectEnvironments.status,
			last_deployed_at: projectEnvironments.last_deployed_at,
			cluster_status: projectCluster.status,
		})
		.from(projectEnvironments)
		.leftJoin(projectCluster, eq(projectCluster.environment_id, projectEnvironments.id))
		.where(inArray(projectEnvironments.id, deployedEnvIds));
	const stageById = new Map(envRows.map((e) => [e.id, e.stage]));
	const activeById = new Map(envRows.map((e) => [e.id, e.status === "ACTIVE"]));
	const eligibleEnvIds = [
		...new Set(envRows.filter((e) => probeEligible(e)).map((e) => e.id)),
	];
	if (eligibleEnvIds.length === 0) return { enqueued: 0 };

	// Latest PROBE_CLUSTER per environment — when each was last probed (any status; a still-running
	// probe counts, so the cadence doesn't re-fire while one is in flight).
	// `hit` = the probe ran and reached the cluster; anything else (a failed or cancelled job, an
	// unreachable or gone answer) is a miss, and leading misses back a non-ACTIVE env's cadence off.
	const probeRows = await db
		.select({
			environment_id: jobs.environment_id,
			created_at: jobs.created_at,
			status: jobs.status,
			reachable: sql<string | null>`${jobs.execution_metadata}->'probe_result'->>'reachable'`,
		})
		.from(jobs)
		.where(and(eq(jobs.job_type, "PROBE_CLUSTER"), inArray(jobs.environment_id, eligibleEnvIds)))
		.orderBy(desc(jobs.created_at));
	const lastProbeByEnv = new Map<string, Date>();
	const historyByEnv = new Map<string, { hit: boolean }[]>();
	for (const r of probeRows) {
		if (!r.environment_id) continue;
		if (!lastProbeByEnv.has(r.environment_id)) lastProbeByEnv.set(r.environment_id, r.created_at);
		// In-flight probes are neither a hit nor a miss; the anti-stampede set below handles them.
		if (r.status === "QUEUED" || r.status === "CLAIMED" || r.status === "PROCESSING") continue;
		const history = historyByEnv.get(r.environment_id) ?? [];
		history.push({ hit: r.status === "SUCCESS" && r.reachable === "true" });
		historyByEnv.set(r.environment_id, history);
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
				inArray(jobs.environment_id, eligibleEnvIds),
			),
		);
	const inFlightProbeEnvs = new Set(
		inFlightProbeRows
			.map((r) => r.environment_id)
			.filter((id): id is string => id !== null),
	);

	const candidates: ProbeCandidate[] = eligibleEnvIds
		.filter((id) => !inFlightProbeEnvs.has(id))
		.map((id) => ({
			environmentId: id,
			projectId: latestDeployByEnv.get(id)?.project_id ?? "",
			tier: tierForStage(stageById.get(id)),
			lastCheckedAt: lastProbeByEnv.get(id) ?? null,
			active: activeById.get(id) ?? false,
			misses: countLeadingMisses(historyByEnv.get(id) ?? []),
		}));

	const due = selectDueForProbe(candidates, at);

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
