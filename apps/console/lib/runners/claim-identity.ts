// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which cloud identity a job may carry or be handed (#5479, #5481). The claim route decrypts the
// identity a job row names and sends it to the runner. `jobs.cloud_identity_id` is written at
// enqueue, and some enqueue paths do not read it through RLS (a rerun copies the original job's id;
// the runner-lifecycle actions copy the runner row's), so the claim route cannot treat the id alone
// as proof the identity belongs to the job's tenant. It loads the identity by id AND the job's
// tenancy, and a row that fails that test is treated as absent.
//
// Both predicates below follow the `scoped_all` RLS policy on `cloud_identities`
// (lib/db/programmables.sql): an `org` row is shared with its org, a `personal` row belongs to its
// author alone. A `personal` row still carries an `org_id`: the org it was created in, which the
// `set_org_id` trigger fills from the session's org when the insert leaves it empty. Every row
// written before migration 0011 added `scope` was defaulted to `personal`, whatever org it sat in;
// migration 0160 returns the ones in a team org to `org`, the sharing they had before 0011. Matching
// `org_id` without `scope` admitted another member's personal credential.

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
 * - an `org`-scope identity whose `org_id` is the job's `org_id` (skipped when the job has no org);
 * - an identity authored by the job's creator that is either `personal` scope or sits in the
 *   creator's personal org (`org_id = user_id`). Personal identities are visible to their author in
 *   every org under the `cloud_identities` RLS policy, so a project in a team org can be configured
 *   with one created in the author's personal org. An `org`-scope identity in some OTHER org is not
 *   admitted by authorship: leaving that org must end access to its credentials.
 *
 * A `personal` identity authored by someone OTHER than the job's creator matches neither arm, even
 * when its `org_id` is the job's org. That is the case a teammate's rerun of a job reaches.
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
			? or(
					and(
						eq(cloudIdentities.org_id, job.org_id),
						eq(cloudIdentities.scope, "org"),
					),
					authoredByCreator,
				)
			: authoredByCreator,
	);
}

/**
 * The WHERE clause that admits identity `id` for a caller acting in `orgId` through
 * `getServiceDb()` — the `scoped_all` RLS policy written out:
 *
 * - an `org`-scope identity of `orgId`;
 * - a `personal` identity authored by `personalAuthorId`, when one is passed. Pass the caller's id
 *   for a SESSION only: for a service token the actor's `userId` is the profile that MINTED it
 *   (`userIdIsTheCaller` in lib/authz/guard.ts), so passing it would hand the minter's personal
 *   credentials to a credential pinned to an org.
 */
export function actorIdentityWhere(
	id: string,
	orgId: string,
	personalAuthorId: string | undefined,
): SQL | undefined {
	const orgShared = and(
		eq(cloudIdentities.org_id, orgId),
		eq(cloudIdentities.scope, "org"),
	);
	return and(
		eq(cloudIdentities.id, id),
		personalAuthorId === undefined
			? orgShared
			: or(
					orgShared,
					and(
						eq(cloudIdentities.user_id, personalAuthorId),
						eq(cloudIdentities.scope, "personal"),
					),
				),
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
