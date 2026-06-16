"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/** After a DEPLOY job succeeds, persist terraform outputs to vine component tables. */
export async function finalizeDeployment(jobId: string) {
	const supabase = await createClient();
	return finalizeDeploymentWithClient(supabase, jobId);
}

/** Shared finalization logic — works with any Supabase client (user or service-role). */
export async function finalizeDeploymentWithClient(
	supabase: SupabaseClient,
	jobId: string,
) {
	const { data: job, error: jobError } = await supabase
		.from("provision_jobs")
		.select("id, status, vine_id, job_type, execution_metadata")
		.eq("id", jobId)
		.single();

	if (jobError || !job) return;
	if (job.status !== "SUCCESS") return;
	if (job.job_type !== "DEPLOY") return;
	if (!job.vine_id) return;

	const meta = job.execution_metadata as Record<string, unknown> | null;
	if (!meta) return;

	const vineId = job.vine_id;
	const clusterName = meta.cluster_name as string | undefined;
	const clusterEndpoint = meta.cluster_endpoint as string | undefined;
	const argocdUrl = meta.argocd_url as string | undefined;
	const argocdAdminPassword = meta.argocd_admin_password as string | undefined;
	const outputs = meta.outputs as Record<string, unknown> | undefined;

	const clusterUpdate: Record<string, unknown> = { status: "ACTIVE" };
	if (clusterName) clusterUpdate.cluster_name = clusterName;
	if (clusterEndpoint) clusterUpdate.cluster_endpoint = clusterEndpoint;
	if (argocdUrl) clusterUpdate.argocd_url = argocdUrl;
	if (argocdAdminPassword) clusterUpdate.argocd_admin_password = argocdAdminPassword;
	if (outputs) {
		const clusterArn = extractOutputValue(outputs, "eks_cluster_arn");
		if (clusterArn) clusterUpdate.cluster_arn = clusterArn;
	}

	await supabase
		.from("vine_cluster")
		.update(clusterUpdate)
		.eq("vine_id", vineId);

	if (outputs) {
		const rdsEndpoint = extractOutputValue(outputs, "rds_cluster_endpoint");
		if (rdsEndpoint) {
			const dbUpdate: Record<string, unknown> = {
				endpoint: rdsEndpoint,
				status: "ACTIVE",
			};
			const rdsId = extractOutputValue(outputs, "rds_cluster_identifier");
			if (rdsId) dbUpdate.cluster_identifier = rdsId;
			const rdsArn = extractOutputValue(outputs, "rds_cluster_arn");
			if (rdsArn) dbUpdate.cluster_arn = rdsArn;
			const masterSecret = extractOutputValue(outputs, "rds_master_credentials_secret_arn");
			if (masterSecret) dbUpdate.master_credentials_secret_arn = masterSecret;
			const extraSecret = extractOutputValue(outputs, "rds_extra_credentials_secret_arn");
			if (extraSecret) dbUpdate.extra_credentials_secret_arn = extraSecret;
			const kmsKey = extractOutputValue(outputs, "rds_credentials_kms_key_arn");
			if (kmsKey) dbUpdate.credentials_kms_key_arn = kmsKey;

			await supabase
				.from("vine_databases")
				.update(dbUpdate)
				.eq("vine_id", vineId);
		}

		const redisEndpoint = extractOutputValue(outputs, "redis_primary_endpoint_address");
		if (redisEndpoint) {
			const cacheUpdate: Record<string, unknown> = {
				endpoint: redisEndpoint,
				status: "ACTIVE",
			};
			const readerEndpoint = extractOutputValue(outputs, "redis_reader_endpoint_address");
			if (readerEndpoint) cacheUpdate.reader_endpoint = readerEndpoint;

			await supabase
				.from("vine_caches")
				.update(cacheUpdate)
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
