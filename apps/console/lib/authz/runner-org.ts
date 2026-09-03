// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray, or } from "drizzle-orm";
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
 *   - `POST /api/cli/runners/deploy` does NOT pass it, because when an executor IS named that
 *     route stamps its `DEPLOY_RUNNER` job with `actor.orgId`; admitting a personal-org
 *     `assigned_runner_id` there would queue a job whose org can never equal its executor's
 *     and which therefore sits QUEUED forever — worse than the defect being fixed. That is a
 *     statement about the ASSIGNED path only: with no executor named, that route now resolves
 *     the stamp from the fleet like every other unassigned enqueue (#4022, see
 *     {@link resolveUnassignedRunnerJobOrg}).
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

/**
 * Chooses the org to stamp an UNASSIGNED runner-lifecycle job with (#4022).
 *
 * `assertRunnerInOrg` answers this whenever an executor is named: the job takes the org of
 * the runner that will run it, so `claim_next_job` Phase A's `j.org_id = v_runner_org_id`
 * holds. With NO executor named there is no runner to read the org back from, and the
 * obvious answer — the actor's org — is only right for HALF the fleet.
 *
 * Nothing about the unassigned path is org-agnostic. `claim_next_job` Phase B has two arms
 * and only the `v_operator = 'managed'` one ignores org; the `ELSE` arm a self runner takes
 * carries the SAME hard equality as Phase A (programmables.sql, `j.org_id =
 * v_runner_org_id`). #3874 stamps runners forward only — the maintainer's ruling refuses a
 * backfill — so a runner deployed by the CLI before it still carries `org_id = user_id`,
 * the deployer's personal org. A Teams member whose runners are ALL of that vintage got a
 * team-org job that no runner of theirs could ever claim: QUEUED forever, no error, nothing
 * that surfaces it. That is the regression #3942's own comment says it exists to avoid — it
 * closed the case where a runner IS named and left the case where one is not.
 *
 * So the org is resolved from the fleet that would have to claim it, and the resolution
 * MIRRORS the claim predicate rather than paraphrasing it: only `self` runners take the
 * `ELSE` arm, and it admits exactly one org value, so the candidates are exactly the self
 * runners whose `org_id` is one of the two orgs this caller is admitted in — their active
 * org and their personal one (the same pair `assertRunnerInOrg`'s transitional admission
 * accepts, and for the same no-backfill reason).
 *
 * BOTH PHASE B ARMS ARE ASKED, because only the ELSE arm is the one this can help. An earlier
 * cut of this function scanned `operator = 'self'` alone and called the result a STRICT
 * improvement — "the personal org is taken only where the previous value was provably
 * unclaimable". That claim was FALSE wherever a managed pool exists. Phase B's managed arm
 * ignores org entirely, and the unassigned path is exactly the one the CLI documents as "an
 * empty id leaves the teardown job for any available runner" (`apps/cli/cmd/runner_destroy.go`),
 * so for an org that runs on the shared pool the old active-org stamp WAS claimable and moving
 * it is a trade, not an improvement. What is traded, for org T on `team` whose member M has only
 * pre-#3874 runners:
 *
 *   | | old (T) | new (M) |
 *   |---|---|---|
 *   | `jobs_set_scheduling` priority | `plan_priority('team') + 2 = 12` | `0 + 2 = 2` |
 *   | managed Phase B cap | `plan_max_concurrency('team') = 8` | `plan_max_concurrency('community') = 2` |
 *   | `assertJobQuotaAllowed` | unbounded (paid) | community 25 jobs / 24h |
 *
 * — and the quota one is not merely slower: `UsageLimitError` is caught by the enqueue route's
 * outer `catch` and returned as an HTTP 500, not a 402. So the resolution asks about the managed
 * pool BEFORE it prefers the personal org, and the preference becomes:
 *
 *   - a self runner in the ACTIVE org exists → the active org, which is what the route
 *     already stamped and is the forward-correct tenancy. A mixed-vintage fleet lands here,
 *     and the modern runner claims it;
 *   - otherwise NO self runner in the personal org either → the active org. An empty fleet has
 *     nothing to satisfy, so the job keeps the more correct tenancy;
 *   - otherwise a MANAGED runner exists → the active org. The old stamp is claimable after all,
 *     and moving it would cost the three rows above for no gain;
 *   - otherwise → the personal org. This is the only value that changes, and it now changes
 *     only where the active-org stamp is claimable by NOTHING — the QUEUED-forever job of #4022.
 *
 * THE MANAGED PROBE IS THE CHEAPEST SOUND QUESTION, DELIBERATELY: *does any managed runner row
 * exist*, not *could this particular managed runner claim this particular job*. The precise
 * question would have to evaluate `supported_providers`, `p_cloud_identity_id`, DRAINING and the
 * per-org cap — and every one of those is a way to answer "no managed runner can claim it" when
 * one can. This probe fails the other way: it over-reports "managed can claim", and over-reporting
 * there means KEEPING THE STAMP THE ROUTE ALREADY WROTE. So the resolver can only ever fix a
 * provably-dead job and can never trade a live one down a plan band. The cost of the imprecision
 * is bounded and named: on a hosted install whose managed pool cannot in fact serve this job's
 * provider, #4022 stays unfixed — the status quo, not a regression.
 *
 * `requires_self_runner` is not consulted for the same reason it cannot bite: nothing in the
 * console ever sets it, so a runner-lifecycle row carries the column's `false` default and the
 * managed arm's only job-side gate is satisfied by construction.
 *
 * Note the runner being torn down is itself a candidate here, and that is not an oversight:
 * `claim_next_job` Phase B does not exclude it either, and a resolution that disagreed with
 * the claimer about who can claim would be this same defect in a new place. The CLI's
 * refusal to OFFER it as an executor is a separate, deliberate choice about pinning.
 *
 * Nothing in `claim_next_job` moves. Widening that predicate would fix both vintages at
 * once and is the wrong lever: its `ELSE` arm is the cross-tenant guard that stops a self
 * runner registered with no `cloud_identity_id` and no `supported_providers` from claiming
 * ANY org's queued job and being handed that job's decrypted cloud credential.
 *
 * EVERY UNASSIGNED RUNNER-LIFECYCLE ENQUEUE CALLS THIS — there are five, and the class is only
 * closed if all five do. `POST /api/jobs` (DESTROY_RUNNER), `POST /api/cli/runners/deploy`
 * (DEPLOY_RUNNER), and the three server actions `deployRunner()`, `destroyRunner()` and
 * `updateRunner()`. The three actions insert under `withActorScope`, where the GUC branch of
 * `set_org_id_from_project` stamps `actor.orgId` — the same value, reached by a different route —
 * so they stamp `org_id` explicitly from here instead, and the trigger's fallback never runs.
 * `updateRunner()` takes no executor argument at all, so it is ALWAYS the unassigned case.
 *
 * @param db A service (RLS-bypassing) db handle or an open transaction.
 * @param orgId The caller's active org.
 * @param personalOrgId The caller's personal org (their user id).
 * @returns The org to stamp the job with — always one of the two arguments.
 */
export async function resolveUnassignedRunnerJobOrg(
	db: Db | Tx,
	orgId: string,
	personalOrgId: string,
): Promise<string> {
	// No scope, no resolution — the same shape `assertJobQuotaAllowed` uses. And a
	// community/personal caller's two orgs are the SAME value, so there is nothing to choose
	// between and no reason to read the fleet at all.
	if (!orgId || orgId === personalOrgId) return orgId;

	// ONE read, both Phase B arms. The `self` half is the ELSE arm's admission — it takes exactly
	// one org value, so the only candidates are the caller's two admissible orgs. The `managed`
	// half is the org-agnostic arm asked as a yes/no: a managed runner's `org_id` IS NULL, so it
	// could never appear in the `self` half, and asking separately would be a second round trip
	// for a column this row set already carries.
	const rows = await db
		.selectDistinct({ operator: runners.operator, org_id: runners.org_id })
		.from(runners)
		.where(
			or(
				and(eq(runners.operator, "self"), inArray(runners.org_id, [orgId, personalOrgId])),
				eq(runners.operator, "managed"),
			),
		);

	const selfOrgs = new Set(
		rows.filter((r) => r.operator === "self").map((r) => r.org_id),
	);
	if (selfOrgs.has(orgId)) return orgId;
	if (!selfOrgs.has(personalOrgId)) return orgId;

	// A legacy-only fleet. The active-org stamp is dead to the ELSE arm — but only MOVE it if the
	// managed arm cannot take it either, because moving it costs a plan band, a concurrency cap
	// and a daily quota (see the table above). Over-reporting "managed can claim" keeps the stamp
	// the caller's route already wrote, which is the harmless direction to be wrong in.
	return rows.some((r) => r.operator === "managed") ? orgId : personalOrgId;
}
