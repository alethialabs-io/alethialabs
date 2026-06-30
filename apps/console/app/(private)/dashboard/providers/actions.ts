"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";
import { withScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type AwsConnectionStatus = {
	connected: boolean;
	accountId?: string;
	roleArn?: string;
	identityId?: string;
	externalId?: string;
	name?: string;
};

/** Returns the verified AWS connection status (the org's first connected account). */
export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "aws");
}

/** Lists every connected AWS account for the org (multi-account). */
export async function listAwsIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "aws");
}

/**
 * Gets or creates a pending AWS identity and returns its external id (manage-gated,
 * not activity-logged — this only seeds the connect sheet).
 */
export async function getAwsExternalId() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	const { identityId, externalId } = await conn.initIdentity(actor, "aws");
	if (!externalId) throw new Error("Failed to initialize AWS external ID");
	return { externalId, identityId };
}

/**
 * Re-queues a CONNECTION_TEST for a saved cloud identity (any provider) without
 * re-entering credentials — used by the "Re-verify" affordance on a failed connector.
 */
export async function reverifyCloudIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.requeueConnectionTest(actor, identityId);
}

/** Queues a FETCH_RESOURCES job to refresh cached AWS resources. */
export async function refreshAwsResources(cloudIdentityId: string) {
	const actor = await authorize("fetch_resources", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});

	const jobId = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values({
					user_id: actor.userId,
					org_id: actor.orgId,
					job_type: "FETCH_RESOURCES",
					cloud_identity_id: cloudIdentityId,
					config_snapshot: {},
					status: "QUEUED",
				})
				.returning({ id: jobs.id });
			return job.id;
		},
	);

	notifyScaler();
	return { jobId };
}

/** Persists cached resources from a completed FETCH_RESOURCES job. */
export async function persistCachedResources(
	cloudIdentityId: string,
	jobId: string,
) {
	const actor = await authorize("fetch_resources", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});

	return withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => {
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
		},
	);
}

/** Validates a Role ARN, persists it, and queues a connection test (manage-gated). */
export async function saveAwsIdentity(identityId: string, roleArn: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveAwsIdentity(actor, identityId, roleArn);
}

/** Marks the AWS identity verified using the connection test result (manage-gated). */
export async function verifyAwsIdentity(identityId: string, jobId?: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.verifyIdentity(actor, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the AWS identity to its pending state (manage-gated). */
export async function disconnectAwsIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "aws");
}

/** Renames a cloud account (any provider; manage-gated). */
export async function renameCloudIdentity(identityId: string, name: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.renameIdentity(actor, identityId, name);
	revalidatePath("/dashboard/connectors");
	return result;
}
