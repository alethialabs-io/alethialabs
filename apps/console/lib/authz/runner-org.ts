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
 * ## `personalOrgId` — a TRANSITIONAL third admission (#3874)
 *
 * Two CLI enqueue paths inserted on `getServiceDb()`, whose role bypasses RLS and sets
 * no `app.current_org` GUC, so the `set_org_id` trigger fell through to its last branch
 * and stamped `org_id = user_id`: every runner deployed through `alethia runner deploy`
 * before #3874 carries the deployer's **personal** org, not their team org. #3874 stamps
 * FORWARD ONLY — the maintainer's ruling refuses a backfill, because rewriting tenancy on
 * rows already written has no undo and a user in several orgs gives the migration no rule
 * it could defend. So those runner rows do not move, and a member of a Teams org calling
 * with `orgId = <team org>` would be refused their own historical runner: it becomes
 * **undestroyable**, since `DESTROY_RUNNER` fails closed on this guard.
 *
 * Passing `personalOrgId` (the caller's `userId` — their personal org is their own id)
 * admits that third case. It is the SAME reason PR #3857's list keeps the `owner_all`
 * disjunction's owner arm (`user_id = app.current_owner OR org_id = app.current_org`,
 * programmables.sql:881-889): with no backfill, the historical rows are reachable only
 * through the personal-org arm — which is why that arm is now permanent rather than
 * removable, and why this one is only *transitional* in the sense that it covers rows no
 * new write can create.
 *
 * It is an ALLOWANCE, not a relaxation: `personalOrgId` is the caller's own id, proven by
 * the CLI token, so a third org's runner is still refused. Callers that do NOT pass it are
 * unchanged. The two enqueue paths differ deliberately:
 *   - `POST /api/jobs` `DESTROY_RUNNER` passes it (that is the undestroyable case) and
 *     stamps the job from the RETURNED org, so job and runner match whichever it was.
 *   - `POST /api/cli/runners/deploy` does NOT pass it, because it stamps its `DEPLOY_RUNNER`
 *     job with `actor.orgId`; admitting a personal-org `assigned_runner_id` there would
 *     queue a job whose org can never equal its executor's and which therefore sits QUEUED
 *     forever — worse than the defect being fixed.
 *
 * @param db     A service (RLS-bypassing) db handle or an open transaction.
 * @param runnerId The client-supplied runner id to validate (must be non-null).
 * @param orgId  The caller's active org — the org the job will be scoped to.
 * @param personalOrgId The caller's personal org (their user id), when the call site wants
 *   the transitional pre-#3874 admission above. Omit to keep the strict two-case guard.
 * @returns The runner's own `org_id` — `null` for a managed runner. Enqueue sites stamp the
 *   job with this so `j.org_id = v_runner_org_id` holds at claim time (`claim_next_job`
 *   Phase A, programmables.sql:225) rather than being asserted and then discarded.
 */
export async function assertRunnerInOrg(
	db: Db | Tx,
	runnerId: string,
	orgId: string,
	personalOrgId?: string,
): Promise<string | null> {
	const [row] = await db
		.select({ org_id: runners.org_id })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	// Reject a non-existent runner, OR a self runner owned by another tenant. A managed
	// runner (org_id IS NULL) is accepted — it mirrors claim_next_job's `v_operator =
	// 'managed'` admission and belongs to no tenant. The caller's PERSONAL org is accepted
	// only when the call site asked for it (see the JSDoc above).
	const admitted =
		row !== undefined &&
		(row.org_id === null ||
			row.org_id === orgId ||
			(personalOrgId !== undefined && row.org_id === personalOrgId));

	if (!row || !admitted) {
		throw new ForbiddenError(
			"deploy",
			{ type: "runner", id: runnerId },
			"runner not found or not in caller's org",
		);
	}
	return row.org_id;
}
