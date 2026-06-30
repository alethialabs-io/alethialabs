"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import * as conn from "@/lib/cloud-providers/connections";
import { withScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type AzureConnectionStatus = {
	connected: boolean;
	tenantId?: string;
	subscriptionId?: string;
	clientId?: string;
	identityId?: string;
	name?: string;
};

/** Returns the verified Azure connection status (the org's first connected account). */
export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
	const actor = await currentActor();
	return conn.getStatus(actor, "azure");
}

/** Lists every connected Azure account for the org (multi-account). */
export async function listAzureIdentities(): Promise<conn.ConnectionStatus[]> {
	const actor = await currentActor();
	return conn.listIdentities(actor, "azure");
}

/** Gets or creates a pending Azure identity (manage-gated, not activity-logged). */
export async function initAzureIdentity() {
	const actor = await authorizeQuiet("manage_identities", {
		type: "cloud_identity",
	});
	return conn.initIdentity(actor, "azure");
}

/** Validates the Azure GUIDs, persists them, and queues a connection test. */
export async function saveAzureIdentity(
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.saveAzureIdentity(
		actor,
		identityId,
		tenantId,
		clientId,
		subscriptionId,
	);
}

/** Marks the Azure identity verified using the connection test result. */
export async function verifyAzureIdentity(identityId: string, jobId?: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const result = await conn.verifyIdentity(actor, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the Azure identity to its pending state. */
export async function disconnectAzureIdentity(identityId: string) {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	return conn.disconnectIdentity(actor, identityId, "azure");
}

/** Queues a FETCH_RESOURCES job to refresh cached Azure resources. */
export async function refreshAzureResources(cloudIdentityId: string) {
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
