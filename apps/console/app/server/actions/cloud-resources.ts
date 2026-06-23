"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, sql } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import { cloudIdentities, jobs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

/**
 * Returns a cloud identity's last-cached discovered resources (VPCs/subnets/zones)
 * for read consumers like the AI assistant — so it can suggest an existing VPC or
 * avoid CIDR clashes. PDP-gated on the identity. Never returns credentials.
 */
export async function getCloudIdentityResources(cloudIdentityId: string) {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	return withOwnerScope(actor.userId, async (tx) => {
		const [row] = await tx
			.select({
				provider: cloudIdentities.provider,
				cached_resources: cloudIdentities.cached_resources,
				cached_at: cloudIdentities.cached_at,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloudIdentityId))
			.limit(1);
		if (!row) return { provider: null, resources: null, cachedAt: null };
		return {
			provider: row.provider,
			resources: row.cached_resources ?? null,
			cachedAt: row.cached_at,
		};
	});
}

/** Queues a FETCH_RESOURCES job for any cloud identity, regardless of provider. */
export async function refreshCloudResources(cloudIdentityId: string) {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const userId = actor.userId;

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
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const userId = actor.userId;

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
