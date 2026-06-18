"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

/** Queues a FETCH_RESOURCES job for any cloud identity, regardless of provider. */
export async function refreshCloudResources(cloudIdentityId: string) {
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

/** Persists cached resources from a completed job to the cloud identity, then returns them. */
export async function completeResourceRefresh(
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
		if (cached === undefined || cached === null) {
			return { success: false, resources: null, cachedAt: null };
		}

		const cachedAt = new Date().toISOString();
		// Opaque runner-produced payload → raw jsonb assignment (RLS-scoped by tx).
		await tx.execute(
			sql`update cloud_identities
			    set cached_resources = ${JSON.stringify(cached)}::jsonb, cached_at = ${cachedAt}::timestamptz
			    where id = ${cloudIdentityId}`,
		);

		return { success: true, resources: cached, cachedAt };
	});
}
