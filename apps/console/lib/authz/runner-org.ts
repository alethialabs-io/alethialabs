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
 * reads into `v_runner_org_id`. This guard mirrors the execution guard's admission
 * EXACTLY (`claim_next_job` Phase A: `v_operator = 'managed' OR j.org_id =
 * v_runner_org_id`): the ONLY thing rejected is a **self runner owned by a
 * different tenant** (`org_id` non-null and != the caller's org). Two cases are
 * accepted because the executor could legitimately claim the job:
 *   - the caller's own runner (`org_id === orgId`);
 *   - a **managed** platform-fleet runner (`org_id IS NULL`) — nobody's tenant, it
 *     assumes-role into the job's own org at run time, so pinning to it is the same
 *     as the "any available" managed path (`claim_next_job` Phase B). Rejecting it
 *     here would be stricter than the claim guard and break the self-managed picker,
 *     which legitimately offers managed runners as pin targets.
 * A non-existent runner id is rejected with the SAME error as a cross-tenant one, so
 * callers return an identical not-found/unauthorized response and never disclose a
 * runner's existence across a tenancy boundary.
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

	// Reject a non-existent runner, OR a self runner owned by another tenant. A managed
	// runner (org_id IS NULL) is accepted — it mirrors claim_next_job's `v_operator =
	// 'managed'` admission and belongs to no tenant.
	if (!row || (row.org_id !== null && row.org_id !== orgId)) {
		throw new ForbiddenError(
			"deploy",
			{ type: "runner", id: runnerId },
			"runner not found or not in caller's org",
		);
	}
}
