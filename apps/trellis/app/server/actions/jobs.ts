"use server";

import { createClient } from "@/lib/supabase/server";

export async function getJobStatus(jobId: string) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("provision_jobs")
		.select("status, error_message")
		.eq("id", jobId)
		.single();

	if (error) {
		throw new Error("Failed to get job status");
	}

	return data;
}

/** Fetches all jobs with vine project_name and worker name joined. */
export async function getJobs() {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("provision_jobs")
		.select("*, vines(project_name, vineyard_id), workers(name)")
		.order("created_at", { ascending: false });

	if (error) throw new Error("Failed to fetch jobs: " + error.message);

	return (data ?? []).map((job: any) => ({
		...job,
		vine_name: job.vines?.project_name ?? null,
		vine_vineyard_id: job.vines?.vineyard_id ?? null,
		worker_name: job.workers?.name ?? null,
		vines: undefined,
		workers: undefined,
	}));
}

export async function getPlanResult(jobId: string) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("provision_jobs")
		.select("status, error_message, execution_metadata")
		.eq("id", jobId)
		.single();

	if (error) throw new Error("Failed to get plan result");
	return data;
}

export async function getVineJobs(vineId: string) {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("provision_jobs")
		.select("*")
		.eq("vine_id", vineId)
		.order("created_at", { ascending: false });

	if (error) throw new Error("Failed to fetch vine jobs: " + error.message);
	return data ?? [];
}

export async function rerunJob(jobId: string) {
	const supabase = await createClient();

	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");

	const { data: original, error: fetchError } = await supabase
		.from("provision_jobs")
		.select("job_type, config_snapshot, cloud_identity_id, vineyard_id, vine_id")
		.eq("id", jobId)
		.single();

	if (fetchError || !original) throw new Error("Original job not found");

	const { data: newJob, error: insertError } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			job_type: original.job_type,
			config_snapshot: original.config_snapshot,
			cloud_identity_id: original.cloud_identity_id,
			vineyard_id: original.vineyard_id,
			vine_id: original.vine_id,
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (insertError) throw new Error("Failed to create job: " + insertError.message);
	return newJob;
}
