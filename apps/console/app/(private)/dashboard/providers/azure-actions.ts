"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { createClient } from "@/lib/supabase/server";

export type AzureConnectionStatus = {
	connected: boolean;
	tenantId?: string;
	subscriptionId?: string;
	clientId?: string;
	identityId?: string;
};

/** Returns the verified Azure connection status for the current user. */
export async function getAzureConnectionStatus(): Promise<AzureConnectionStatus> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return { connected: false };
	return conn.getStatus(user.id, "azure");
}

/** Gets or creates the user's pending Azure identity. */
export async function initAzureIdentity() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");
	return conn.initIdentity(user.id, "azure");
}

/** Validates the Azure GUIDs, persists them, and queues a connection test. */
export async function saveAzureIdentity(
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.saveAzureIdentity(
		user.id,
		identityId,
		tenantId,
		clientId,
		subscriptionId,
	);
}

/** Marks the Azure identity verified using the connection test result. */
export async function verifyAzureIdentity(identityId: string, jobId?: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	const result = await conn.verifyIdentity(user.id, identityId, jobId);
	revalidatePath("/dashboard/connectors");
	return result;
}

/** Resets the Azure identity to its pending state. */
export async function disconnectAzureIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.disconnectIdentity(user.id, identityId, "azure");
}

/** Queues a FETCH_RESOURCES job to refresh cached Azure resources. */
export async function refreshAzureResources(cloudIdentityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) throw new Error("Unauthorized");

	const jobId = await withOwnerScope(user.id, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: user.id,
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
