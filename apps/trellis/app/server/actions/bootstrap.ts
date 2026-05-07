"use server";

import { createClient } from "@/lib/supabase/server";

export async function getBootstrapJobs(vineyardId: string) {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("bootstrap_jobs")
			.select("*")
			.eq("vineyard_id", vineyardId)
			.order("created_at", { ascending: false });

		if (error) {
			throw new Error(error.message);
		}

		return { jobs: data };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function getBootstrapLogs(jobId: string) {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("bootstrap_logs")
			.select("id, log_chunk, stream_type, created_at")
			.eq("job_id", jobId)
			.order("id", { ascending: true });

		if (error) {
			throw new Error(error.message);
		}

		return { logs: data };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}