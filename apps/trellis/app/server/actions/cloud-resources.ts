"use server";

import { notifyScaler } from "@/lib/scaler";
import { createClient } from "@/lib/supabase/server";

/** Queues a FETCH_RESOURCES job for any cloud identity, regardless of provider. */
export async function refreshCloudResources(cloudIdentityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const { data: job, error } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			job_type: "FETCH_RESOURCES",
			cloud_identity_id: cloudIdentityId,
			config_snapshot: {},
			status: "QUEUED",
		})
		.select("id")
		.single();

	if (error)
		throw new Error("Failed to queue resource fetch: " + error.message);

	notifyScaler();
	return { jobId: job.id };
}

/** Persists cached resources from a completed job to the cloud identity, then returns them. */
export async function completeResourceRefresh(
	cloudIdentityId: string,
	jobId: string,
) {
	const supabase = await createClient();

	const { data: job } = await supabase
		.from("provision_jobs")
		.select("execution_metadata")
		.eq("id", jobId)
		.single();

	const metadata = job?.execution_metadata;
	if (!metadata?.cached_resources) {
		return { success: false, resources: null, cachedAt: null };
	}

	const cachedAt = new Date().toISOString();

	const resources = metadata.cached_resources as Record<string, unknown>;

	await supabase
		.from("cloud_identities")
		.update({
			cached_resources: resources as any,
			cached_at: cachedAt,
		})
		.eq("id", cloudIdentityId);

	return {
		success: true,
		resources,
		cachedAt,
	};
}
