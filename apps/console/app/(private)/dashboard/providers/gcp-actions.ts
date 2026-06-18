"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { createClient } from "@/lib/supabase/server";

export type GcpConnectionStatus = {
	connected: boolean;
	projectId?: string;
	serviceAccountEmail?: string;
	identityId?: string;
};

/** Returns the verified GCP connection status for the current user. */
export async function getGcpConnectionStatus(): Promise<GcpConnectionStatus> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return { connected: false };
	return conn.getStatus(user.id, "gcp");
}

/** Gets or creates the user's pending GCP identity. */
export async function initGcpIdentity() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");
	return conn.initIdentity(user.id, "gcp");
}

/** Validates a WIF config JSON, persists it, and queues a connection test. */
export async function saveGcpIdentity(identityId: string, wifConfigJson: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.saveGcpIdentity(user.id, identityId, wifConfigJson);
}

/** Marks the GCP identity verified using the connection test result. */
export async function verifyGcpIdentity(identityId: string, jobId?: string) {
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

/** Resets the GCP identity to its pending state. */
export async function disconnectGcpIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.disconnectIdentity(user.id, identityId, "gcp");
}

/** Queues a FETCH_RESOURCES job to refresh cached GCP resources. */
export async function refreshGcpResources(cloudIdentityId: string) {
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
