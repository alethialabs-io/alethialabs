"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { getOwner, requireOwner } from "@/lib/auth/owner";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type AzureConnectionStatus = {
	connected: boolean;
	tenantId?: string;
	subscriptionId?: string;
	clientId?: string;
	identityId?: string;
};

/** Returns the verified Azure connection status for the current user. */
export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
	const userId = await getOwner();
	if (!userId) return { connected: false };
	return conn.getStatus(userId, "azure");
}

/** Gets or creates the user's pending Azure identity. */
export async function initAzureIdentity() {
	const userId = await requireOwner();
	return conn.initIdentity(userId, "azure");
}

/** Validates the Azure GUIDs, persists them, and queues a connection test. */
export async function saveAzureIdentity(
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
) {
	const userId = await requireOwner();
	return conn.saveAzureIdentity(
		userId,
		identityId,
		tenantId,
		clientId,
		subscriptionId,
	);
}

/** Marks the Azure identity verified using the connection test result. */
export async function verifyAzureIdentity(identityId: string, jobId?: string) {
	const userId = await requireOwner();
	const result = await conn.verifyIdentity(userId, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the Azure identity to its pending state. */
export async function disconnectAzureIdentity(identityId: string) {
	const userId = await requireOwner();
	return conn.disconnectIdentity(userId, identityId, "azure");
}

/** Queues a FETCH_RESOURCES job to refresh cached Azure resources. */
export async function refreshAzureResources(cloudIdentityId: string) {
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
