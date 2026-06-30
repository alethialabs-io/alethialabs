"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";
import { withScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type GcpConnectionStatus = {
	connected: boolean;
	projectId?: string;
	serviceAccountEmail?: string;
	identityId?: string;
	name?: string;
};

/** Returns the verified GCP connection status (the org's first connected account). */
export async function getGcpConnectionStatus(): Promise<GcpConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "gcp");
}

/** Lists every connected GCP account for the org (multi-account). */
export async function listGcpIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "gcp");
}

/** Gets or creates a pending GCP identity (manage-gated, not activity-logged). */
export async function initGcpIdentity() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	return conn.initIdentity(actor, "gcp");
}

/** Validates a WIF config JSON, persists it, and queues a connection test. */
export async function saveGcpIdentity(identityId: string, wifConfigJson: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveGcpIdentity(actor, identityId, wifConfigJson);
}

/** Marks the GCP identity verified using the connection test result. */
export async function verifyGcpIdentity(identityId: string, jobId?: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.verifyIdentity(actor, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the GCP identity to its pending state. */
export async function disconnectGcpIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "gcp");
}

/** Queues a FETCH_RESOURCES job to refresh cached GCP resources. */
export async function refreshGcpResources(cloudIdentityId: string) {
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
