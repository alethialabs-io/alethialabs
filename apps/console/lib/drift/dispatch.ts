// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema/jobs";
import { projectEnvironments } from "@/lib/db/schema/project-environments";
import { notifyScaler } from "@/lib/scaler";
import {
	type DriftCandidate,
	selectDueForDrift,
	tierForStage,
} from "@/lib/drift/schedule";

/**
 * Enqueue DETECT_DRIFT jobs for every environment whose last drift check is older
 * than its tier cadence (elench). Runs at service level (no user session) — hit by
 * a platform cron via the internal sweep route. The drift snapshot is copied from
 * the environment's latest successful DEPLOY job, so a refresh-only plan reads the
 * exact provisioned config/state. Selection is the unit-tested `selectDueForDrift`.
 */
export async function sweepDriftSchedule(
	now: Date = new Date(),
): Promise<{ enqueued: number }> {
	const db = getServiceDb();

	// Latest successful DEPLOY per environment — the drift snapshot source.
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
	const envIds = [...latestDeployByEnv.keys()];
	if (envIds.length === 0) return { enqueued: 0 };

	// Latest DETECT_DRIFT per environment — when each was last checked.
	const driftRows = await db
		.select({ environment_id: jobs.environment_id, created_at: jobs.created_at })
		.from(jobs)
		.where(eq(jobs.job_type, "DETECT_DRIFT"))
		.orderBy(desc(jobs.created_at));
	const lastDriftByEnv = new Map<string, Date>();
	for (const r of driftRows) {
		if (r.environment_id && !lastDriftByEnv.has(r.environment_id)) {
			lastDriftByEnv.set(r.environment_id, r.created_at);
		}
	}

	// Anti-stampede: an env with a DETECT_DRIFT job still in flight (QUEUED/CLAIMED/PROCESSING) must
	// NOT get a second one. The cadence check keys off the LATEST drift job's created_at regardless of
	// status, so a check that was queued a full cadence ago but is still running (a slow/stuck runner)
	// would otherwise re-enqueue a duplicate each pass and pile up. Exclude those envs here.
	const inFlightDriftRows = await db
		.select({ environment_id: jobs.environment_id })
		.from(jobs)
		.where(
			and(
				eq(jobs.job_type, "DETECT_DRIFT"),
				inArray(jobs.status, ["QUEUED", "CLAIMED", "PROCESSING"]),
				inArray(jobs.environment_id, envIds),
			),
		);
	const inFlightDriftEnvs = new Set(
		inFlightDriftRows.map((r) => r.environment_id).filter((id): id is string => id !== null),
	);

	const stageRows = await db
		.select({ id: projectEnvironments.id, stage: projectEnvironments.stage })
		.from(projectEnvironments)
		.where(inArray(projectEnvironments.id, envIds));
	const stageById = new Map(stageRows.map((e) => [e.id, e.stage]));

	const candidates: DriftCandidate[] = envIds
		.filter((id) => !inFlightDriftEnvs.has(id))
		.map((id) => ({
			environmentId: id,
			projectId: latestDeployByEnv.get(id)?.project_id ?? "",
			tier: tierForStage(stageById.get(id)),
			lastCheckedAt: lastDriftByEnv.get(id) ?? null,
		}));

	const due = selectDueForDrift(candidates, now);

	let enqueued = 0;
	for (const c of due) {
		const src = latestDeployByEnv.get(c.environmentId);
		if (!src) continue;
		// Cross-replica dedup: the `uq_jobs_active_drift_per_env` partial unique index guarantees at most
		// ONE in-flight DETECT_DRIFT per env, so a racing replica's concurrent INSERT for the same env
		// is dropped instead of piling up a duplicate. Target + where must match the partial index
		// (columns = environment_id, predicate = the in-flight-drift filter). `.returning` lets us count
		// only the rows that actually landed (a dropped conflict returns none).
		const inserted = await db
			.insert(jobs)
			.values(signedJob({
				user_id: src.user_id,
				project_id: src.project_id,
				environment_id: c.environmentId,
				cloud_identity_id: src.cloud_identity_id,
				job_type: "DETECT_DRIFT",
				config_snapshot: src.config_snapshot,
				status: "QUEUED",
			}))
			.onConflictDoNothing({
				target: jobs.environment_id,
				where: sql`job_type = 'DETECT_DRIFT' AND status IN ('QUEUED', 'CLAIMED', 'PROCESSING')`,
			})
			.returning({ id: jobs.id });
		if (inserted.length > 0) enqueued++;
	}
	if (enqueued > 0) notifyScaler();
	return { enqueued };
}
