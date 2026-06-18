"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { getOwner, requireOwner } from "@/lib/auth/owner";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

export type GcpConnectionStatus = {
	connected: boolean;
	projectId?: string;
	serviceAccountEmail?: string;
	identityId?: string;
};

/** Returns the verified GCP connection status for the current user. */
export async function getGcpConnectionStatus(): Promise<GcpConnectionStatus> {
	const userId = await getOwner();
	if (!userId) return { connected: false };
	return conn.getStatus(userId, "gcp");
}

/** Gets or creates the user's pending GCP identity. */
export async function initGcpIdentity() {
	const userId = await requireOwner();
	return conn.initIdentity(userId, "gcp");
}

/** Validates a WIF config JSON, persists it, and queues a connection test. */
export async function saveGcpIdentity(identityId: string, wifConfigJson: string) {
	const userId = await requireOwner();
	return conn.saveGcpIdentity(userId, identityId, wifConfigJson);
}

/** Marks the GCP identity verified using the connection test result. */
export async function verifyGcpIdentity(identityId: string, jobId?: string) {
	const userId = await requireOwner();
	const result = await conn.verifyIdentity(userId, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the GCP identity to its pending state. */
export async function disconnectGcpIdentity(identityId: string) {
	const userId = await requireOwner();
	return conn.disconnectIdentity(userId, identityId, "gcp");
}

/** Queues a FETCH_RESOURCES job to refresh cached GCP resources. */
export async function refreshGcpResources(cloudIdentityId: string) {
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
