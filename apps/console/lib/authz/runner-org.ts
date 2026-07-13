// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { ForbiddenError } from "@/lib/authz/types";
import type { Db, Tx } from "@/lib/db";
import { runners } from "@/lib/db/schema";

/**
 * Defense-in-depth guard for a client-supplied `assigned_runner_id`.
 *
 * Job-enqueue endpoints let the caller pin a job to a specific runner. The
 * cross-tenant *execution* is already blocked by `claim_next_job` (a self runner
 * may only claim an assigned job when `j.org_id = v_runner_org_id`), but nothing
 * stops a caller from writing ANOTHER org's runner id onto the job at enqueue —
 * which creates an unclaimable/orphaned job and confirms another org's runner id
 * back to the caller. This asserts, at enqueue, that the runner belongs to the
 * caller's org so we fail closed BEFORE the job row is inserted.
 *
 * The runner's owning org is `runners.org_id` — the SAME column `claim_next_job`
 * reads into `v_runner_org_id`, so this uses an identical notion of "the runner's
 * org" as the execution guard. Managed (platform-fleet) runners carry a NULL
 * org_id and are never tenant-assignable by id, so they are correctly rejected.
 *
 * Throws {@link ForbiddenError} for BOTH "runner belongs to another org" and
 * "runner does not exist", so callers can return an identical not-found /
 * unauthorized response and never disclose a runner's existence across a tenancy
 * boundary.
 *
 * @param db     A service (RLS-bypassing) db handle or an open transaction.
 * @param runnerId The client-supplied runner id to validate (must be non-null).
 * @param orgId  The caller's active org — the org the job will be scoped to.
 */
export async function assertRunnerInOrg(
	db: Db | Tx,
	runnerId: string,
	orgId: string,
): Promise<void> {
	const [row] = await db
		.select({ org_id: runners.org_id })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	if (!row || row.org_id !== orgId) {
		throw new ForbiddenError(
			"deploy",
			{ type: "runner", id: runnerId },
			"runner not found or not in caller's org",
		);
	}
}
