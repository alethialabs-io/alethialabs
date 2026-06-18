"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { jobs, specCaches, specCluster, specDatabases, specs } from "@/lib/db/schema";

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
 * After a DEPLOY job succeeds, persist terraform outputs to the spec component
 * tables. Service path — runs on the BYPASSRLS connection (worker-triggered).
 */
export async function finalizeDeployment(jobId: string) {
	const db = getServiceDb();

	const [job] = await db
		.select({
			status: jobs.status,
			spec_id: jobs.spec_id,
			job_type: jobs.job_type,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) return;
	if (job.status !== "SUCCESS") return;
	if (job.job_type !== "DEPLOY") return;
	if (!job.spec_id) return;
	if (!job.execution_metadata) return;

	const specId = job.spec_id;
	const meta = deployMetaSchema.parse(job.execution_metadata);
	const outputs = meta.outputs;

	const clusterUpdate: Partial<typeof specCluster.$inferInsert> = {
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
		if (clusterArn) clusterUpdate.cluster_arn = clusterArn;
	}

	await db.update(specCluster).set(clusterUpdate).where(eq(specCluster.spec_id, specId));

	if (outputs) {
		const rdsEndpoint = extractOutputValue(outputs, "rds_cluster_endpoint");
		if (rdsEndpoint) {
			const dbUpdate: Partial<typeof specDatabases.$inferInsert> = {
				endpoint: rdsEndpoint,
				status: "ACTIVE",
			};
			const rdsId = extractOutputValue(outputs, "rds_cluster_identifier");
			if (rdsId) dbUpdate.cluster_identifier = rdsId;
			const rdsArn = extractOutputValue(outputs, "rds_cluster_arn");
			if (rdsArn) dbUpdate.cluster_arn = rdsArn;
			const masterSecret = extractOutputValue(
				outputs,
				"rds_master_credentials_secret_arn",
			);
			if (masterSecret) dbUpdate.master_credentials_secret_arn = masterSecret;
			const extraSecret = extractOutputValue(
				outputs,
				"rds_extra_credentials_secret_arn",
			);
			if (extraSecret) dbUpdate.extra_credentials_secret_arn = extraSecret;
			const kmsKey = extractOutputValue(
				outputs,
				"rds_credentials_kms_key_arn",
			);
			if (kmsKey) dbUpdate.credentials_kms_key_arn = kmsKey;

			await db
				.update(specDatabases)
				.set(dbUpdate)
				.where(eq(specDatabases.spec_id, specId));
		}

		const redisEndpoint = extractOutputValue(
			outputs,
			"redis_primary_endpoint_address",
		);
		if (redisEndpoint) {
			const cacheUpdate: Partial<typeof specCaches.$inferInsert> = {
				endpoint: redisEndpoint,
				status: "ACTIVE",
			};
			const readerEndpoint = extractOutputValue(
				outputs,
				"redis_reader_endpoint_address",
			);
			if (readerEndpoint) cacheUpdate.reader_endpoint = readerEndpoint;

			await db
				.update(specCaches)
				.set(cacheUpdate)
				.where(eq(specCaches.spec_id, specId));
		}
	}

	await db.update(specs).set({ status: "ACTIVE" }).where(eq(specs.id, specId));
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
