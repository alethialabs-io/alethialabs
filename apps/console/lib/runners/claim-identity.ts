// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which cloud identity a claimed job may be handed (#5479). The claim route decrypts the identity a
// job row names and sends it to the runner. `jobs.cloud_identity_id` is written at enqueue, and at
// least one enqueue path (POST /api/jobs, DESTROY_RUNNER) took it from the request body, so the claim
// route cannot treat the id alone as proof the identity belongs to the job's tenant. It loads the
// identity by id AND the job's tenancy, and a row that fails that test is treated as absent.

import { and, eq, or, type SQL } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";

/** The job fields the tenancy test reads. */
export interface ClaimIdentityJob {
	cloud_identity_id: string;
	org_id: string | null;
	user_id: string;
}

/**
 * The WHERE clause that admits `job.cloud_identity_id` only when the identity belongs to the job's
 * tenant. Two arms:
 *
 * - the identity's `org_id` is the job's `org_id` (skipped when the job has no org);
 * - the identity was authored by the job's creator AND is either `personal` scope or sits in the
 *   creator's personal org (`org_id = user_id`). Personal identities are visible to their author in
 *   every org under the `cloud_identities` RLS policy, so a project in a team org can be configured
 *   with one created in the author's personal org. An `org`-scope identity in some OTHER org is not
 *   admitted by authorship: leaving that org must end access to its credentials.
 */
export function claimIdentityWhere(job: ClaimIdentityJob): SQL | undefined {
	const authoredByCreator = and(
		eq(cloudIdentities.user_id, job.user_id),
		or(
			eq(cloudIdentities.scope, "personal"),
			eq(cloudIdentities.org_id, job.user_id),
		),
	);
	return and(
		eq(cloudIdentities.id, job.cloud_identity_id),
		job.org_id
			? or(eq(cloudIdentities.org_id, job.org_id), authoredByCreator)
			: authoredByCreator,
	);
}

/** Loads the claimed job's cloud identity, or null when none passes {@link claimIdentityWhere}. */
export async function loadClaimIdentity(
	db: ReturnType<typeof getServiceDb>,
	job: ClaimIdentityJob,
) {
	const [identity] = await db
		.select({
			credentials: cloudIdentities.credentials,
			provider: cloudIdentities.provider,
		})
		.from(cloudIdentities)
		.where(claimIdentityWhere(job))
		.limit(1);
	return identity ?? null;
}
