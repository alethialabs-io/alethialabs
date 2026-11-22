// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// TELLING SOMEONE THAT A CLUSTER IS MISSING (#6736).
//
// lib/clusters/observed-state.ts decides when a cluster may be called missing. This module is the
// side that acts on that decision, and the only thing it does is SAY so: when a drift scan or a
// probe is ingested (app/api/jobs/[id]/status/route.ts) and the environment's observation goes from
// not-missing to `missing`, it writes one system activity-log row and raises one
// `system.project.cluster_missing` alert. It never changes a status. What to do about a missing
// cluster is the user's call — redeploy, tear down, or mark it destroyed
// (app/server/actions/missing-cluster.ts) — and every one of those is a person's click.
//
// ONCE PER FINDING. Two gates, for two different repeats:
//   · the TRANSITION (`newlyMissing`): a later scan that still finds the cluster gone is the same
//     finding, so the observation read BEFORE the reading must not already be `missing`;
//   · the ROW: a finding is its environment and its evidence sentence (`missingEvidence`, which
//     carries the reading's own stamp). Before notifying, the activity log is asked whether that
//     row already exists — a re-posted status callback, or two ingests racing the same reading,
//     find it and stay quiet. The row is written BEFORE the alert is raised, so a failed write
//     raises nothing rather than an alert with no record behind it.
//
// Service-role, like every reader of these tables (lib/clusters/observed-evidence.ts says why);
// every read is scoped to the job's org explicitly.

import "server-only";

import { and, eq, gte } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { recordSystemActivity } from "@/lib/authz/activity";
import { readClusterEvidence } from "@/lib/clusters/observed-evidence";
import {
	type ControlPlaneObservation,
	missingEvidence,
	newlyMissing,
	observeControlPlane,
} from "@/lib/clusters/observed-state";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, projectEnvironments, projects } from "@/lib/db/schema";

/** The activity-log action of a missing-cluster finding Alethia recorded. */
const CLUSTER_MISSING_ACTION = "cluster_missing";

/** The alert key a missing-cluster finding raises (lib/alerts/catalog.ts `cluster.missing`). */
export const CLUSTER_MISSING_EVENT = "system.project.cluster_missing";

/** An environment, and what has been observed of its control plane. */
export interface ObservedEnvironment {
	environmentId: string;
	environmentName: string;
	projectId: string;
	projectName: string;
	/** `project_environments.status`. */
	status: string;
	observation: ControlPlaneObservation;
}

/**
 * Reads one environment of `orgId` and derives its control-plane observation from the same three
 * readings every surface derives it from (the last deploy, the latest drift scan, the latest
 * probe). Null when the environment is not the org's.
 */
export async function readEnvironmentObservation(
	orgId: string,
	environmentId: string,
	now: Date = new Date(),
): Promise<ObservedEnvironment | null> {
	const [env] = await getServiceDb()
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			stage: projectEnvironments.stage,
			status: projectEnvironments.status,
			last_deployed_at: projectEnvironments.last_deployed_at,
			project_id: projects.id,
			project_name: projects.project_name,
		})
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(and(eq(projectEnvironments.id, environmentId), eq(projects.org_id, orgId)))
		.limit(1);
	if (!env) return null;
	const evidence = await readClusterEvidence(orgId, [environmentId]);
	return {
		environmentId: env.id,
		environmentName: env.name,
		projectId: env.project_id,
		projectName: env.project_name,
		status: env.status,
		observation: observeControlPlane({
			lastDeployedAt: env.last_deployed_at?.toISOString() ?? null,
			stage: env.stage,
			drift: evidence.drift.get(environmentId) ?? null,
			probe: evidence.probes.get(environmentId) ?? null,
			now,
		}),
	};
}

/**
 * The observation of `environmentId` as it stands BEFORE a reading is recorded — the baseline
 * {@link notifyIfClusterNewlyMissing} compares against. Null when it cannot be read: a failed read
 * must not fail the runner's status update, and with no baseline nothing is notified (a missed
 * notification is shown on the cards anyway; a wrong one cannot be taken back).
 */
export async function observationBeforeReading(
	orgId: string | null,
	environmentId: string | null,
): Promise<ControlPlaneObservation | null> {
	if (!orgId || !environmentId) return null;
	try {
		return (await readEnvironmentObservation(orgId, environmentId))?.observation ?? null;
	} catch {
		return null;
	}
}

/**
 * The activity-log name of an environment: its project and itself, as the feed shows it. Recorded
 * with the row because an environment has no live name lookup in the feed.
 */
export function environmentLabel(env: Pick<ObservedEnvironment, "projectName" | "environmentName">): string {
	return `${env.projectName} / ${env.environmentName}`;
}

/** Statuses whose cluster is being, or has been, torn down: a cluster found gone there is expected. */
const TEARDOWN_STATUSES: ReadonlySet<string> = new Set(["DESTROYING", "DESTROYED"]);

/** Whether the activity log already holds this finding (same environment, same evidence). */
async function findingRecorded(orgId: string, environmentId: string, reason: string, since: Date): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: authzActivityLog.id })
		.from(authzActivityLog)
		.where(
			and(
				eq(authzActivityLog.org_id, orgId),
				eq(authzActivityLog.action, CLUSTER_MISSING_ACTION),
				eq(authzActivityLog.resource_type, "environment"),
				eq(authzActivityLog.resource_id, environmentId),
				eq(authzActivityLog.reason, reason),
				// Bounds the read to the idx_authz_activity_ts range after the reading; a day of slack
				// covers a runner whose clock ran ahead of the console's.
				gte(authzActivityLog.ts, since),
			),
		)
		.limit(1);
	return Boolean(row);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * After a drift scan or probe of `environmentId` was recorded: when it turned the observation
 * `missing` (it was not before — `before` is the observation read just ahead of recording it), and
 * the activity log does not already hold that finding, records the finding as a system activity
 * row and raises `system.project.cluster_missing`. Returns whether it notified.
 *
 * Nothing here changes a status. An environment being torn down is skipped: its cluster going away
 * is what was asked for.
 */
export async function notifyIfClusterNewlyMissing(input: {
	orgId: string;
	environmentId: string;
	before: ControlPlaneObservation | null;
	jobId: string;
	jobType: string;
}): Promise<boolean> {
	if (input.before === null) return false;
	const after = await readEnvironmentObservation(input.orgId, input.environmentId);
	if (!after || TEARDOWN_STATUSES.has(after.status)) return false;
	const finding = newlyMissing(input.before, after.observation);
	if (!finding) return false;

	const reason = missingEvidence(finding);
	const observedAt = Date.parse(finding.observedAt);
	const since = new Date((Number.isNaN(observedAt) ? Date.now() : observedAt) - DAY_MS);
	if (await findingRecorded(input.orgId, input.environmentId, reason, since)) return false;

	await recordSystemActivity(
		input.orgId,
		CLUSTER_MISSING_ACTION,
		{ type: "environment", id: input.environmentId },
		{ reason, resourceName: environmentLabel(after) },
	);
	emitAlertEventSafe(input.orgId, CLUSTER_MISSING_EVENT, {
		title: "Cluster missing",
		summary: `${environmentLabel(after)}: ${reason}. Nothing was changed: redeploy the environment, tear it down, or mark it as destroyed.`,
		severity: "critical",
		resource_type: "environment",
		resource_id: input.environmentId,
		reason,
		job_id: input.jobId,
		job_type: input.jobType,
		project_id: after.projectId,
	});
	return true;
}
