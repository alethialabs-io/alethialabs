"use server";

import { createClient } from "@/lib/supabase/server";

/** After a DEPLOY job succeeds, persist terraform outputs to vine component tables. */
export async function finalizeDeployment(jobId: string) {
	const supabase = await createClient();

	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.select("id, status, vine_id, execution_metadata")
		.eq("id", jobId)
		.single();

	if (jobError || !job) throw new Error("Job not found");
	if (job.status !== "SUCCESS") return;
	if (!job.vine_id) return;

	const meta = job.execution_metadata as Record<string, unknown> | null;
	if (!meta) return;

	const vineId = job.vine_id;
	const clusterName = meta.cluster_name as string | undefined;
	const clusterEndpoint = meta.cluster_endpoint as string | undefined;
	const outputs = meta.outputs as Record<string, unknown> | undefined;

	if (clusterName || clusterEndpoint) {
		await supabase
			.from("vine_cluster")
			.update({
				cluster_name: clusterName || null,
				cluster_endpoint: clusterEndpoint || null,
				status: "ACTIVE",
			})
			.eq("vine_id", vineId);
	}

	if (outputs) {
		const rdsEndpoint = extractOutputValue(outputs, "rds_cluster_endpoint");
		if (rdsEndpoint) {
			await supabase
				.from("vine_databases")
				.update({ endpoint: rdsEndpoint, status: "ACTIVE" })
				.eq("vine_id", vineId);
		}

		const redisEndpoint = extractOutputValue(
			outputs,
			"redis_primary_endpoint_address",
		);
		if (redisEndpoint) {
			await supabase
				.from("vine_caches")
				.update({ endpoint: redisEndpoint, status: "ACTIVE" })
				.eq("vine_id", vineId);
		}
	}

	await supabase.from("vines").update({ status: "ACTIVE" }).eq("id", vineId);
}

function extractOutputValue(
	outputs: Record<string, unknown>,
	key: string,
): string | null {
	const val = outputs[key];
	if (!val) return null;
	if (typeof val === "string") return val;
	if (typeof val === "object" && val !== null && "value" in val) {
		const v = (val as Record<string, unknown>).value;
		if (typeof v === "string") return v;
	}
	return null;
}
