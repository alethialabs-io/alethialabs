"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import { notifyScaler } from "@/lib/scaler";
import { jobs, projectServices } from "@/lib/db/schema";

/**
 * W2 image build & push — the console side of the BUILD job (see
 * management/spec/features/w2-image-build-push.md). A BUILD job runs kaniko in the
 * customer's cluster (the renderer is packages/core/imagebuild), pushes each repo-sourced
 * service's image to ECR, and posts back a per-service digest map. These finalizers run on
 * the runner's status callback (app/api/jobs/[id]/status) — service-role, no user session —
 * mirroring finalizeDeployment (deployments.ts) and applyGateDecision (promotions.ts).
 */

/**
 * build_result is the runner's per-service map `{ service_name -> image_digest_uri }`, e.g.
 * "<acct>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:…". Digests are non-secret and pass
 * the metadata scrub; parsed defensively since it is runner-supplied JSON.
 */
const buildResultSchema = z.record(z.string(), z.string());

/**
 * finalizeBuild persists each built image digest into its service's resolved_image column.
 * The manifest renderer (W2 #589) then substitutes resolved_image for the workload image,
 * retiring the "<name>:latest" placeholder. No-op unless the job is a SUCCESS BUILD carrying
 * a build_result. Idempotent: re-running just re-writes the same digests.
 */
export async function finalizeBuild(jobId: string) {
	const db = getServiceDb();

	const [job] = await db
		.select({
			status: jobs.status,
			job_type: jobs.job_type,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) return;
	if (job.job_type !== "BUILD") return;
	if (job.status !== "SUCCESS") return;
	if (!job.project_id || !job.environment_id) return;

	const parsed = buildResultSchema.safeParse(job.execution_metadata?.build_result);
	if (!parsed.success) return;

	// project_services is environment-scoped — write each digest to the built env's row only.
	const projectId = job.project_id;
	const environmentId = job.environment_id;
	for (const [serviceName, image] of Object.entries(parsed.data)) {
		if (!image) continue;
		await db
			.update(projectServices)
			.set({ resolved_image: image, updated_at: new Date() })
			.where(
				and(
					eq(projectServices.project_id, projectId),
					eq(projectServices.environment_id, environmentId),
					eq(projectServices.name, serviceName),
				),
			);
	}
}

/**
 * enqueueDeployAfterBuild chains the app-workload DEPLOY once the images exist: it moves the
 * env to QUEUED through the CAS FIRST (so a lost race — the env left a deployable state under
 * us — does NOT strand an orphan DEPLOY), then inserts a DEPLOY reusing the BUILD job's frozen
 * config_snapshot (the DEPLOY renders the services with the just-persisted resolved_image).
 * Mirrors applyGateDecision's PLAN→DEPLOY chain; runs on the service DB from the status callback.
 */
export async function enqueueDeployAfterBuild(buildJobId: string) {
	const db = getServiceDb();

	const [buildJob] = await db
		.select({
			status: jobs.status,
			job_type: jobs.job_type,
			user_id: jobs.user_id,
			org_id: jobs.org_id,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			cloud_identity_id: jobs.cloud_identity_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(eq(jobs.id, buildJobId))
		.limit(1);

	if (!buildJob) return;
	if (buildJob.job_type !== "BUILD") return;
	if (buildJob.status !== "SUCCESS") return;
	if (!buildJob.project_id || !buildJob.environment_id) return;

	const moved = await transitionEnv(
		db,
		buildJob.environment_id,
		"enqueueDeploy",
		null,
		{ orgId: buildJob.org_id ?? undefined, projectId: buildJob.project_id },
	);
	if (!moved) return;

	const [deploy] = await db
		.insert(jobs)
		.values({
			user_id: buildJob.user_id,
			org_id: buildJob.org_id ?? undefined,
			project_id: buildJob.project_id,
			environment_id: buildJob.environment_id,
			cloud_identity_id: buildJob.cloud_identity_id,
			job_type: "DEPLOY",
			config_snapshot: buildJob.config_snapshot,
			status: "QUEUED",
		})
		.returning({ id: jobs.id });

	notifyScaler();
	return { deployJobId: deploy.id };
}
