"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { notifyScaler } from "@/lib/scaler";
import { createClient } from "@/lib/supabase/server";
import { PublicWorkerMode } from "@/lib/validations/db.schemas";
import { createHash, randomBytes } from "crypto";

export async function registerWorker(name: string, mode: PublicWorkerMode) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const workerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const { data: worker, error } = await supabase
		.from("workers")
		.insert({
			user_id: user.id,
			name,
			mode,
			token_hash: tokenHash,
		})
		.select("id, name, mode, status, created_at")
		.single();

	if (error) {
		throw new Error("Failed to register worker: " + error.message);
	}

	return { worker, worker_token: workerToken };
}

/** Sets (or clears) the default worker for the current user. */
export async function setDefaultWorker(workerId: string | null) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { error } = await supabase.rpc("set_default_worker", {
		p_worker_id: workerId ?? undefined,
	});

	if (error)
		throw new Error("Failed to set default worker: " + error.message);
}

/** Returns all workers visible to the current user, default first. */
export async function getAvailableWorkers() {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("workers")
		.select("id, name, mode, status, is_default")
		.order("is_default", { ascending: false })
		.order("name", { ascending: true });

	if (error) throw new Error("Failed to fetch workers: " + error.message);
	return data ?? [];
}

/** Deploys a self-hosted worker container to the user's cloud account. */
export async function deployWorker(params: {
	name: string;
	cloudIdentityId: string;
	region: string;
	imageTag?: string;
	assignedWorkerId?: string | null;
}) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const workerToken = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(workerToken).digest("hex");

	const { data: worker, error: workerError } = await supabase
		.from("workers")
		.insert({
			user_id: user.id,
			name: params.name,
			mode: "self-hosted" as const,
			token_hash: tokenHash,
			cloud_identity_id: params.cloudIdentityId,
		})
		.select("id, name")
		.single();

	if (workerError)
		throw new Error("Failed to register worker: " + workerError.message);

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("provider")
		.eq("id", params.cloudIdentityId)
		.single();

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

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			cloud_identity_id: params.cloudIdentityId,
			job_type: "DEPLOY_WORKER",
			config_snapshot: configSnapshot,
			status: "QUEUED",
			assigned_worker_id: params.assignedWorkerId ?? undefined,
		})
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue deployment: " + jobError.message);

	notifyScaler();
	return { workerId: worker.id, jobId: job.id };
}

/** Fetches a deployed worker, verifies ownership, and resolves cloud provider. */
async function fetchDeployedWorker(workerId: string) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { data: worker, error: workerError } = await supabase
		.from("workers")
		.select("id, name, user_id, cloud_identity_id, metadata")
		.eq("id", workerId)
		.single();

	if (workerError || !worker) throw new Error("Worker not found");
	if (worker.user_id !== user.id) throw new Error("Unauthorized");
	if (!worker.cloud_identity_id)
		throw new Error("Worker has no cloud identity");

	const deployConfig = worker.metadata?.deploy_config;
	if (!deployConfig)
		throw new Error(
			"Worker has no deploy config — it may not have been deployed successfully",
		);

	const { data: identity } = await supabase
		.from("cloud_identities")
		.select("provider")
		.eq("id", worker.cloud_identity_id)
		.single();

	return { supabase, user, worker, deployConfig, identity };
}

/** Builds a worker config snapshot from deploy_config with optional overrides. */
function buildWorkerConfigSnapshot(
	worker: { id: string; name: string },
	deployConfig: NonNullable<Awaited<ReturnType<typeof fetchDeployedWorker>>["deployConfig"]>,
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
			deployConfig.image_repository ??
			"ghcr.io/alethialabs-io/runner",
	};
}

/** Queues a DESTROY_WORKER job for a self-hosted worker with cloud resources. */
export async function destroyWorker(workerId: string, assignedWorkerId?: string | null) {
	const { supabase, user, worker, deployConfig, identity } =
		await fetchDeployedWorker(workerId);

	const { data: activeJobs } = await supabase
		.from("provision_jobs")
		.select("id, config_snapshot")
		.eq("user_id", user.id)
		.eq("job_type", "DESTROY_WORKER")
		.in("status", ["QUEUED", "CLAIMED", "PROCESSING"]);

	const duplicate = activeJobs?.find(
		(j) => (j.config_snapshot as Record<string, unknown>)?.worker_id === workerId,
	);

	if (duplicate) {
		throw new Error("A destroy job is already in progress for this worker");
	}

	const configSnapshot = buildWorkerConfigSnapshot(
		worker, deployConfig, identity?.provider,
		{ worker_token: deployConfig.worker_token },
	);

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			cloud_identity_id: worker.cloud_identity_id!,
			job_type: "DESTROY_WORKER",
			config_snapshot: configSnapshot,
			status: "QUEUED",
			assigned_worker_id: assignedWorkerId ?? undefined,
		})
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue destroy job: " + jobError.message);

	notifyScaler();
	return { jobId: job.id };
}

/** Queues an UPDATE_WORKER job to roll a deployed worker to the latest release. */
export async function updateWorker(workerId: string) {
	const { supabase, user, worker, deployConfig, identity } =
		await fetchDeployedWorker(workerId);

	if (!deployConfig.worker_token)
		throw new Error(
			"Worker is missing deploy token — re-deploy required to enable updates",
		);

	const { data: latestRelease } = await supabase
		.from("worker_releases")
		.select("version")
		.order("released_at", { ascending: false })
		.limit(1)
		.single();

	if (!latestRelease)
		throw new Error("No worker releases found");

	const configSnapshot = buildWorkerConfigSnapshot(
		worker, deployConfig, identity?.provider,
		{
			worker_token: deployConfig.worker_token,
			image_tag: latestRelease.version,
		},
	);

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			cloud_identity_id: worker.cloud_identity_id!,
			job_type: "UPDATE_WORKER",
			config_snapshot: configSnapshot,
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue update job: " + jobError.message);

	notifyScaler();
	return { jobId: job.id };
}

/** Deletes a worker record directly (no cloud resources to tear down). */
export async function removeWorker(workerId: string) {
	const supabase = await createClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { data: worker } = await supabase
		.from("workers")
		.select("id, user_id")
		.eq("id", workerId)
		.single();

	if (!worker) throw new Error("Worker not found");
	if (worker.user_id !== user.id) throw new Error("Unauthorized");

	const { error } = await supabase
		.from("workers")
		.delete()
		.eq("id", workerId);

	if (error) throw new Error("Failed to remove worker: " + error.message);
}
