"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getOwner, requireOwner } from "@/lib/auth/owner";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type AwsConnectionStatus = {
	connected: boolean;
	accountId?: string;
	roleArn?: string;
	identityId?: string;
	externalId?: string;
};

/** Returns the verified AWS connection status for the current user. */
export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
	const userId = await getOwner();
	if (!userId) return { connected: false };
	return conn.getStatus(userId, "aws");
}

/** Gets or creates the user's AWS identity and returns its external id. */
export async function getAwsExternalId() {
	const userId = await requireOwner();
	const { identityId, externalId } = await conn.initIdentity(userId, "aws");
	if (!externalId) throw new Error("Failed to initialize AWS external ID");
	return { externalId, identityId };
}

/** Queues a FETCH_RESOURCES job to refresh cached AWS resources. */
export async function refreshAwsResources(cloudIdentityId: string) {
	const userId = await requireOwner();

	const jobId = await withOwnerScope(userId, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: userId,
				job_type: "FETCH_RESOURCES",
				cloud_identity_id: cloudIdentityId,
				config_snapshot: {},
				status: "QUEUED",
			})
			.returning({ id: jobs.id });
		return job.id;
	});

	notifyScaler();
	return { jobId };
}

/** Persists cached resources from a completed FETCH_RESOURCES job. */
export async function persistCachedResources(
	cloudIdentityId: string,
	jobId: string,
) {
	const userId = await requireOwner();

	return withOwnerScope(userId, async (tx) => {
		const [job] = await tx
			.select({ execution_metadata: jobs.execution_metadata })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		const cached = job?.execution_metadata?.cached_resources;
		if (cached === undefined || cached === null) return { success: false };

		// Opaque runner-produced payload → raw jsonb assignment (RLS-scoped by tx).
		await tx.execute(
			sql`update cloud_identities
			    set cached_resources = ${JSON.stringify(cached)}::jsonb, cached_at = now()
			    where id = ${cloudIdentityId}`,
		);
		return { success: true };
	});
}

/** Validates a Role ARN, persists it, and queues a connection test. */
export async function saveAwsIdentity(identityId: string, roleArn: string) {
	const userId = await requireOwner();
	return conn.saveAwsIdentity(userId, identityId, roleArn);
}

/** Marks the AWS identity verified using the connection test result. */
export async function verifyAwsIdentity(identityId: string, jobId?: string) {
	const userId = await requireOwner();
	const result = await conn.verifyIdentity(userId, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the AWS identity to its pending state. */
export async function disconnectAwsIdentity(identityId: string) {
	const userId = await requireOwner();
	return conn.disconnectIdentity(userId, identityId, "aws");
}
