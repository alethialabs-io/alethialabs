"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectEnvironments,
} from "@/lib/db/schema";
import type { ProviderOutputs } from "@/types/jsonb.types";

// execution_metadata is JSONB written by the runner. Parse the fields we read
// (lenient: .catch(undefined) mirrors the old optional-read behavior without casts).
const deployMetaSchema = z.object({
	cluster_name: z.string().optional().catch(undefined),
	cluster_endpoint: z.string().optional().catch(undefined),
	argocd_url: z.string().optional().catch(undefined),
	argocd_admin_password: z.string().optional().catch(undefined),
	outputs: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/**
 * After a DEPLOY job succeeds, persist terraform outputs to the project component
 * tables. Service path — runs on the BYPASSRLS connection (runner-triggered).
 */
export async function finalizeDeployment(jobId: string) {
	const db = getServiceDb();

	const [job] = await db
		.select({
			status: jobs.status,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			job_type: jobs.job_type,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) return;
	if (job.status !== "SUCCESS") return;
	if (job.job_type !== "DEPLOY") return;
	if (!job.project_id) return;
	if (!job.execution_metadata) return;

	const projectId = job.project_id;
	const meta = deployMetaSchema.parse(job.execution_metadata);
	const outputs = meta.outputs;

	const clusterUpdate: Partial<typeof projectCluster.$inferInsert> = {
		status: "ACTIVE",
	};
	if (meta.cluster_name) clusterUpdate.cluster_name = meta.cluster_name;
	if (meta.cluster_endpoint)
		clusterUpdate.cluster_endpoint = meta.cluster_endpoint;
	if (meta.argocd_url) clusterUpdate.argocd_url = meta.argocd_url;
	if (meta.argocd_admin_password)
		clusterUpdate.argocd_admin_password = meta.argocd_admin_password;
	if (outputs) {
		const clusterArn = extractOutputValue(outputs, "eks_cluster_arn");
		if (clusterArn) clusterUpdate.provider_outputs = { arn: clusterArn };
	}

	await db.update(projectCluster).set(clusterUpdate).where(eq(projectCluster.project_id, projectId));

	if (outputs) {
		const rdsEndpoint = extractOutputValue(outputs, "rds_cluster_endpoint");
		if (rdsEndpoint) {
			const dbOutputs: ProviderOutputs = {};
			const rdsId = extractOutputValue(outputs, "rds_cluster_identifier");
			if (rdsId) dbOutputs.identifier = rdsId;
			const rdsArn = extractOutputValue(outputs, "rds_cluster_arn");
			if (rdsArn) dbOutputs.arn = rdsArn;
			const masterSecret = extractOutputValue(
				outputs,
				"rds_master_credentials_secret_arn",
			);
			if (masterSecret) dbOutputs.secret_ref = masterSecret;
			const extraSecret = extractOutputValue(
				outputs,
				"rds_extra_credentials_secret_arn",
			);
			if (extraSecret) dbOutputs.extra_secret_ref = extraSecret;
			const kmsKey = extractOutputValue(
				outputs,
				"rds_credentials_kms_key_arn",
			);
			if (kmsKey) dbOutputs.kms_key = kmsKey;

			const dbUpdate: Partial<typeof projectDatabases.$inferInsert> = {
				endpoint: rdsEndpoint,
				status: "ACTIVE",
				provider_outputs: dbOutputs,
			};

			await db
				.update(projectDatabases)
				.set(dbUpdate)
				.where(eq(projectDatabases.project_id, projectId));
		}

		const redisEndpoint = extractOutputValue(
			outputs,
			"redis_primary_endpoint_address",
		);
		if (redisEndpoint) {
			const cacheUpdate: Partial<typeof projectCaches.$inferInsert> = {
				endpoint: redisEndpoint,
				status: "ACTIVE",
			};
			const readerEndpoint = extractOutputValue(
				outputs,
				"redis_reader_endpoint_address",
			);
			if (readerEndpoint) cacheUpdate.reader_endpoint = readerEndpoint;

			await db
				.update(projectCaches)
				.set(cacheUpdate)
				.where(eq(projectCaches.project_id, projectId));
		}
	}

	// M1: mark the targeted environment ACTIVE (status moved off projects).
	if (job.environment_id) {
		await db
			.update(projectEnvironments)
			.set({ status: "ACTIVE" })
			.where(eq(projectEnvironments.id, job.environment_id));
	}
}

/** Extracts a string from a terraform output entry (raw string or { value }). */
function extractOutputValue(
	outputs: Record<string, unknown>,
	key: string,
): string | null {
	const val = outputs[key];
	if (!val) return null;
	if (typeof val === "string") return val;
	if (typeof val === "object" && val !== null && "value" in val) {
		const v = val.value;
		if (typeof v === "string") return v;
	}
	return null;
}
