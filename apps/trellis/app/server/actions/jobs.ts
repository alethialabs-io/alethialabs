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
