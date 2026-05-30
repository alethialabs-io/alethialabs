"use server";

import { createClient } from "@/lib/supabase/server";

export type VpcInfo = {
	id: string;
	cidr: string;
	name: string;
	isDefault: boolean;
};

export async function requestVpcList(
	cloudIdentityId: string,
	region: string,
): Promise<{ jobId: string }> {
	const supabase = await createClient();

	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");

	const { data: job, error } = await supabase
		.from("provision_jobs")
		.insert({
			user_id: user.id,
			cloud_identity_id: cloudIdentityId,
			job_type: "FETCH_RESOURCES",
			status: "QUEUED",
			config_snapshot: { region },
		})
		.select("id")
		.single();

	if (error || !job) throw new Error("Failed to create VPC listing job");

	return { jobId: job.id };
}

export async function getVpcListResult(
	jobId: string,
): Promise<{ status: string; vpcs: VpcInfo[] | null }> {
	const supabase = await createClient();

	const { data: job, error } = await supabase
		.from("provision_jobs")
		.select("status, execution_metadata")
		.eq("id", jobId)
		.single();

	if (error || !job) throw new Error("Job not found");

	if (job.status === "SUCCESS") {
		const metadata = job.execution_metadata as Record<string, unknown>;
		return {
			status: "SUCCESS",
			vpcs: (metadata?.vpcs as VpcInfo[]) ?? [],
		};
	}

	if (job.status === "FAILED") {
		return { status: "FAILED", vpcs: null };
	}

	return { status: job.status, vpcs: null };
}
