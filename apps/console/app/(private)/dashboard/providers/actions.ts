"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import * as conn from "@/lib/cloud-providers/connections";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { createClient } from "@/lib/supabase/server";

export type AwsConnectionStatus = {
	connected: boolean;
	accountId?: string;
	roleArn?: string;
	identityId?: string;
	externalId?: string;
};

/** Returns the verified AWS connection status for the current user. */
export async function getAwsConnectionStatus(): Promise<AwsConnectionStatus> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return { connected: false };
	return conn.getStatus(user.id, "aws");
}

/** Gets or creates the user's AWS identity and returns its external id. */
export async function getAwsExternalId() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");
	const { identityId, externalId } = await conn.initIdentity(user.id, "aws");
	if (!externalId) throw new Error("Failed to initialize AWS external ID");
	return { externalId, identityId };
}

/** Queues a FETCH_RESOURCES job to refresh cached AWS resources. */
export async function refreshAwsResources(cloudIdentityId: string) {
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

/** Persists cached resources from a completed FETCH_RESOURCES job. */
export async function persistCachedResources(
	cloudIdentityId: string,
	jobId: string,
) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) throw new Error("Unauthorized");

	return withOwnerScope(user.id, async (tx) => {
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
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.saveAwsIdentity(user.id, identityId, roleArn);
}

/** Marks the AWS identity verified using the connection test result. */
export async function verifyAwsIdentity(identityId: string, jobId?: string) {
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

/** Resets the AWS identity to its pending state. */
export async function disconnectAwsIdentity(identityId: string) {
	const supabase = await createClient();
	const {
		data: { user },
		error: authError,
	} = await supabase.auth.getUser();
	if (authError || !user) throw new Error("Unauthorized");
	return conn.disconnectIdentity(user.id, identityId, "aws");
}
