"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs the canvas can run against an environment (W6).
//
// `provision_job_type` has thirteen values. AUDIT, DETECT_DRIFT, PROBE_CLUSTER, CHART_SCAN and
// IAC_SCAN all exist, all have runner-side executors, and drift and probe even run on a SCHEDULE
// already — and the canvas offered exactly two of them: Deploy and Destroy.
//
// Nothing here is a new backend capability. `planProject` / `queueDriftDetection` / `scanByoChart` /
// `scanIacSource` already existed; these two fill the gaps so every job the platform can run is
// reachable from the board:
//   • probe-now  — the scheduled sweeper could probe; a person could not.
//   • audit-this-environment — `queueAudit` took a plan JSON you had to supply yourself. There was
//     no way to say "audit what I have".

import { and, desc, eq, inArray } from "drizzle-orm";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { signedJob } from "@/lib/db/signed-job";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectEnvironments,
	projects,
	type ProvisionJobStatus,
	type ProvisionJobType,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { withOwnerScope } from "@/lib/db";

/** Jobs the environment is still working through. */
const IN_FLIGHT = ["QUEUED", "CLAIMED", "PROCESSING"] as const;

/** The environment must belong to a project in the caller's org. */
async function assertEnvInOrg(
	projectId: string,
	environmentId: string,
	orgId: string,
) {
	const db = getServiceDb();
	const [env] = await db
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(
			and(
				eq(projectEnvironments.id, environmentId),
				eq(projectEnvironments.project_id, projectId),
				eq(projects.org_id, orgId),
			),
		)
		.limit(1);
	if (!env) throw new Error("Environment not found.");
}

/**
 * The job whose `config_snapshot` a follow-up job should reuse: the environment's last successful
 * DEPLOY. A probe reads the environment's OpenTofu state outputs to find the cluster, so it has to
 * run against the same configuration the deploy used — which is exactly what the scheduled sweeper
 * does (`lib/probes/dispatch.ts`).
 */
async function lastDeploy(projectId: string, environmentId: string) {
	const db = getServiceDb();
	const [row] = await db
		.select({
			user_id: jobs.user_id,
			project_id: jobs.project_id,
			cloud_identity_id: jobs.cloud_identity_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, environmentId),
				eq(jobs.job_type, "DEPLOY"),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);
	return row ?? null;
}

/** True when the environment already has a job of this type in flight. */
async function hasInFlight(
	projectId: string,
	environmentId: string,
	jobType: "PROBE_CLUSTER" | "AUDIT",
) {
	const db = getServiceDb();
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, environmentId),
				eq(jobs.job_type, jobType),
				inArray(jobs.status, [...IN_FLIGHT]),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Probe the environment's cluster now — "is it still up?".
 *
 * The scheduled sweeper could already do this; a person could not. Reuses the last successful
 * DEPLOY's snapshot, because the probe reads that environment's state outputs to reach the API
 * server. An environment that was never deployed has nothing to probe.
 */
export async function queueClusterProbe(
	projectId: string,
	environmentId: string,
): Promise<{ jobId: string }> {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	await assertEnvInOrg(projectId, environmentId, actor.orgId);

	const src = await lastDeploy(projectId, environmentId);
	if (!src) {
		throw new Error(
			"This environment has never been deployed, so there's no cluster to probe.",
		);
	}
	// One probe at a time per environment — the sweeper enforces the same rule, and a queue of
	// identical probes tells you nothing a single one wouldn't.
	if (await hasInFlight(projectId, environmentId, "PROBE_CLUSTER")) {
		throw new Error("A cluster probe is already running for this environment.");
	}
	await assertJobQuotaAllowed(actor.orgId);

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: src.user_id,
				project_id: projectId,
				environment_id: environmentId,
				cloud_identity_id: src.cloud_identity_id,
				job_type: "PROBE_CLUSTER",
				initiated_by: "user",
				config_snapshot: src.config_snapshot,
				status: "QUEUED",
			}))
			.returning({ id: jobs.id });
		return job.id;
	});

	notifyScaler();
	return { jobId };
}

/**
 * Audit this environment — run the verify engine over its LATEST plan.
 *
 * `queueAudit` already existed, but it took a plan JSON you had to supply yourself (the "bring your
 * own infrastructure" flow). There was no way to say "audit what I have". This finds the
 * environment's most recent successful PLAN, and audits exactly that.
 *
 * A plan is required, and that's the honest constraint: auditing is a judgement about a concrete
 * set of resources, and without a plan there is nothing concrete to judge.
 */
export async function queueEnvironmentAudit(
	projectId: string,
	environmentId: string,
): Promise<{ jobId: string }> {
	const actor = await authorize("plan", { type: "project", id: projectId });
	await assertEnvInOrg(projectId, environmentId, actor.orgId);

	const db = getServiceDb();
	const [plan] = await db
		.select({ metadata: jobs.execution_metadata })
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, environmentId),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);

	const planResult = plan?.metadata?.plan_result;
	if (!planResult) {
		throw new Error("Run a plan first — there's nothing to audit yet.");
	}
	if (await hasInFlight(projectId, environmentId, "AUDIT")) {
		throw new Error("An audit is already running for this environment.");
	}
	await assertJobQuotaAllowed(actor.orgId);

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				project_id: projectId,
				initiated_by: "user",
				environment_id: environmentId,
				job_type: "AUDIT",
				status: "QUEUED",
				config_snapshot: {
					audit_kind: "plan",
					audit_input:
						typeof planResult === "string"
							? planResult
							: JSON.stringify(planResult),
				},
			}))
			.returning({ id: jobs.id });
		return job.id;
	});

	notifyScaler();
	return { jobId };
}

/** One row in the canvas's activity rail. */
export interface EnvironmentJob {
	id: string;
	type: ProvisionJobType;
	status: ProvisionJobStatus;
	createdAt: string;
	error: string | null;
}

/**
 * The environment's recent jobs — the activity rail. Scoped to ONE environment, because the board
 * only ever shows one, and a project-wide list would attribute another environment's failure to the
 * design you're looking at.
 */
export async function getEnvironmentJobs(
	projectId: string,
	environmentId: string,
	limit = 8,
): Promise<EnvironmentJob[]> {
	const actor = await authorize("view", { type: "project", id: projectId });
	await assertEnvInOrg(projectId, environmentId, actor.orgId);

	const db = getServiceDb();
	const rows = await db
		.select({
			id: jobs.id,
			job_type: jobs.job_type,
			status: jobs.status,
			created_at: jobs.created_at,
			error_message: jobs.error_message,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, environmentId),
				eq(jobs.org_id, actor.orgId),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(limit);

	return rows.map((r) => ({
		id: r.id,
		type: r.job_type,
		status: r.status,
		createdAt: r.created_at.toISOString(),
		error: r.error_message,
	}));
}
