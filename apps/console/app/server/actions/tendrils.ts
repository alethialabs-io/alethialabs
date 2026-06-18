"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { createHash, randomBytes } from "crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

type WorkerMode = "self-hosted" | "cloud-hosted";

export async function registerWorker(name: string, mode: WorkerMode) {
	const owner = await requireOwner();
	const workerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const worker = await withOwnerScope(owner, async (tx) => {
		const [w] = await tx
			.insert(runners)
			.values({ user_id: owner, name, mode, token_hash: tokenHash })
			.returning({
				id: runners.id,
				name: runners.name,
				mode: runners.mode,
				status: runners.status,
				created_at: runners.created_at,
			});
		return w;
	});

	return { worker, worker_token: workerToken };
}

/** Sets (or clears) the default worker for the current user. */
export async function setDefaultWorker(workerId: string | null) {
	const owner = await requireOwner();
	await getServiceDb().execute(
		sql`select set_default_runner(${owner}::uuid, ${workerId ?? null}::uuid)`,
	);
}

/** Returns all workers visible to the current user, default first. */
export async function getAvailableWorkers() {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) =>
		tx
			.select({
				id: runners.id,
				name: runners.name,
				mode: runners.mode,
				status: runners.status,
				is_default: runners.is_default,
			})
			.from(runners)
			.orderBy(desc(runners.is_default), asc(runners.name)),
	);
}

/** Deploys a self-hosted worker container to the user's cloud account. */
export async function deployWorker(params: {
	name: string;
	cloudIdentityId: string;
	region: string;
	imageTag?: string;
	assignedWorkerId?: string | null;
}) {
	const owner = await requireOwner();
	const workerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const result = await withOwnerScope(owner, async (tx) => {
		const [worker] = await tx
			.insert(runners)
			.values({
				user_id: owner,
				name: params.name,
				mode: "self-hosted",
				token_hash: tokenHash,
				cloud_identity_id: params.cloudIdentityId,
			})
			.returning({ id: runners.id, name: runners.name });

		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, params.cloudIdentityId))
			.limit(1);

		const configSnapshot = {
			worker_id: worker.id,
			worker_token: workerToken,
			worker_name: params.name,
			image_tag: params.imageTag || "latest",
			region: params.region,
			cloud_provider: identity?.provider ?? "aws",
			trellis_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://adp.prod.itgix.eu",
		};

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: params.cloudIdentityId,
				job_type: "DEPLOY_WORKER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: params.assignedWorkerId ?? null,
			})
			.returning({ id: jobs.id });

		return { workerId: worker.id, jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Fetches a deployed worker, verifies ownership, and resolves cloud provider. */
async function fetchDeployedWorker(owner: string, workerId: string) {
	return withOwnerScope(owner, async (tx) => {
		const [worker] = await tx
			.select({
				id: runners.id,
				name: runners.name,
				user_id: runners.user_id,
				cloud_identity_id: runners.cloud_identity_id,
				metadata: runners.metadata,
			})
			.from(runners)
			.where(eq(runners.id, workerId))
			.limit(1);

		if (!worker) throw new Error("Worker not found");
		if (worker.user_id !== owner) throw new Error("Unauthorized");
		if (!worker.cloud_identity_id)
			throw new Error("Worker has no cloud identity");

		const deployConfig = worker.metadata?.deploy_config;
		if (!deployConfig)
			throw new Error(
				"Worker has no deploy config — it may not have been deployed successfully",
			);

		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, worker.cloud_identity_id))
			.limit(1);

		return { worker, deployConfig, identity: identity ?? null };
	});
}

/** Builds a worker config snapshot from deploy_config with optional overrides. */
function buildWorkerConfigSnapshot(
	worker: { id: string; name: string },
	deployConfig: NonNullable<
		Awaited<ReturnType<typeof fetchDeployedWorker>>["deployConfig"]
	>,
	provider: string | null | undefined,
	overrides?: { worker_token?: string; image_tag?: string },
) {
	return {
		worker_id: worker.id,
		worker_token: overrides?.worker_token ?? "",
		worker_name: worker.name,
		region: deployConfig.region,
		cloud_provider: provider ?? deployConfig.cloud_provider ?? "aws",
		image_tag: overrides?.image_tag ?? deployConfig.image_tag ?? "latest",
		trellis_url:
			deployConfig.trellis_url ??
			process.env.NEXT_PUBLIC_APP_URL ??
			"https://adp.prod.itgix.eu",
		cpu: deployConfig.cpu ?? 512,
		memory: deployConfig.memory ?? 1024,
		image_repository:
			deployConfig.image_repository ?? "ghcr.io/alethialabs-io/runner",
	};
}

/** Queues a DESTROY_WORKER job for a self-hosted worker with cloud resources. */
export async function destroyWorker(
	workerId: string,
	assignedWorkerId?: string | null,
) {
	const owner = await requireOwner();
	const { worker, deployConfig, identity } = await fetchDeployedWorker(
		owner,
		workerId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		const activeJobs = await tx
			.select({ id: jobs.id, config_snapshot: jobs.config_snapshot })
			.from(jobs)
			.where(
				and(
					eq(jobs.user_id, owner),
					eq(jobs.job_type, "DESTROY_WORKER"),
					inArray(jobs.status, ["QUEUED", "CLAIMED", "PROCESSING"]),
				),
			);

		const duplicate = activeJobs.find(
			(j) => j.config_snapshot?.worker_id === workerId,
		);
		if (duplicate) {
			throw new Error("A destroy job is already in progress for this worker");
		}

		const configSnapshot = buildWorkerConfigSnapshot(
			worker,
			deployConfig,
			identity?.provider,
			{ worker_token: deployConfig.worker_token },
		);

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: worker.cloud_identity_id!,
				job_type: "DESTROY_WORKER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assignedWorkerId ?? null,
			})
			.returning({ id: jobs.id });

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Queues an UPDATE_WORKER job to roll a deployed worker to the latest release. */
export async function updateWorker(workerId: string) {
	const owner = await requireOwner();
	const { worker, deployConfig, identity } = await fetchDeployedWorker(
		owner,
		workerId,
	);

	if (!deployConfig.worker_token)
		throw new Error(
			"Worker is missing deploy token — re-deploy required to enable updates",
		);

	const result = await withOwnerScope(owner, async (tx) => {
		const [latestRelease] = await tx
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		if (!latestRelease) throw new Error("No worker releases found");

		const configSnapshot = buildWorkerConfigSnapshot(
			worker,
			deployConfig,
			identity?.provider,
			{
				worker_token: deployConfig.worker_token,
				image_tag: latestRelease.version,
			},
		);

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: worker.cloud_identity_id!,
				job_type: "UPDATE_WORKER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
			})
			.returning({ id: jobs.id });

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Deletes a worker record directly (no cloud resources to tear down). */
export async function removeWorker(workerId: string) {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		const [worker] = await tx
			.select({ id: runners.id, user_id: runners.user_id })
			.from(runners)
			.where(eq(runners.id, workerId))
			.limit(1);

		if (!worker) throw new Error("Worker not found");
		if (worker.user_id !== owner) throw new Error("Unauthorized");

		await tx.delete(runners).where(eq(runners.id, workerId));
	});
}
