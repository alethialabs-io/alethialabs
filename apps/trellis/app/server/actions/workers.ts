"use server";

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
		})
		.select("id")
		.single();

	if (jobError)
		throw new Error("Failed to queue deployment: " + jobError.message);

	return { workerId: worker.id, jobId: job.id };
}
