// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Free-tier daily job quota — the VOLUME half of the fleet cost ceiling (the concurrency cap +
// global instance ceiling bound instantaneous cost; this bounds cumulative enqueues). Called by the
// USER-facing enqueue paths (server actions + CLI job routes) right before inserting a job, next to
// assertUsageAllowed. SYSTEM enqueues (reconcile / drift / probe / ephemeral-reaper / auto-heal /
// build-chain) run on getServiceDb() with no actor and never call this guard, so auto-reconcile is
// never throttled — and, doubly, the count only tallies rows stamped `initiated_by = 'user'`.
//
// EXEMPT JOB TYPES (#5313). The count is every user-initiated job EXCEPT the types in
// QUOTA_EXEMPT_JOB_TYPES — an exclusion, not a list of included types, so a job type added later
// counts by default and exempting one is a decision someone writes down here. The one exemption is
// MINT_KUBECONFIG: access to your own cluster must never be what stops you deploying, and an exec
// kubeconfig re-mints once per TTL. A mint is still bounded by the per-user mint rate limit
// (app/api/cli/clusters/[id]/kubeconfig/route.ts), still metered as runner minutes
// (assertUsageAllowed), and still subject to the plan's concurrency cap at claim time
// (programmables.sql org_managed_inflight) — this file exempts it from the daily COUNT only. Its
// enqueue path (lib/kubeconfig-mint/request.ts) therefore does not call this guard.
//
// THE CAP is `abuseLimit("free_daily_jobs")` from the typed ceilings table (lib/abuse/limits.ts,
// REL-S3): default 25, overridden by `ALETHIA_FREE_DAILY_JOB_QUOTA` with the table's rule (a positive
// number is floored and used; anything else keeps the default). This file holds no copy of it.
//
// FAIL OPEN, LOUDLY (REL-L11, #6912). A count query that errors admits the job — a soft cost guard
// must not wedge provisioning — and raises `system.platform.cost_guard_failed_open` on the platform
// operator's org (lib/abuse/platform-alert.ts), so a quota that is silently not enforcing is seen.

import "server-only";
import { and, count, eq, gte, notInArray } from "drizzle-orm";
import { abuseLimit } from "@/lib/abuse/limits";
import {
	COST_GUARD_FAILED_OPEN_EVENT,
	raisePlatformAbuseAlert,
} from "@/lib/abuse/platform-alert";
import { getOrgBilling } from "@/lib/billing/queries";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { getServiceDb } from "@/lib/db";
import { jobs, type ProvisionJobType } from "@/lib/db/schema";

/** Job types a user may enqueue without them counting toward the daily quota (#5313). */
export const QUOTA_EXEMPT_JOB_TYPES: readonly ProvisionJobType[] = ["MINT_KUBECONFIG"];

/** The configured trailing-24h user-job cap for free/community orgs, read from the ceilings table. */
export function freeDailyJobQuota(): number {
	return abuseLimit("free_daily_jobs");
}

/**
 * Blocks a new USER-initiated enqueue when a free/community org has already enqueued
 * {@link freeDailyJobQuota} jobs in the trailing 24 hours, not counting {@link QUOTA_EXEMPT_JOB_TYPES}. Paid orgs (team/enterprise) are
 * unbounded here — their cost is bounded by the concurrency cap + global instance ceiling, and
 * overage bills. A billing-read error is read as `community` (capped). A count-query error must
 * never wedge provisioning, so it returns (allows) rather than throwing — this is a soft cost guard,
 * not a security control — and raises the fail-open platform alert. Throws {@link UsageLimitError}
 * (upgradable) when the cap is hit.
 */
export async function assertJobQuotaAllowed(orgId: string): Promise<void> {
	// No scope, no count — can't attribute usage without an org, so fail open rather than guess.
	if (!orgId) return;

	const billing = await getOrgBilling(orgId).catch(() => null);
	const plan = billing?.plan ?? "community";
	// Only free/community orgs are capped; everyone else is unbounded here.
	if (plan !== "community") return;

	const cap = freeDailyJobQuota();
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

	let used: number;
	try {
		const [row] = await getServiceDb()
			.select({ c: count() })
			.from(jobs)
			.where(
				and(
					eq(jobs.org_id, orgId),
					eq(jobs.initiated_by, "user"),
					notInArray(jobs.job_type, [...QUOTA_EXEMPT_JOB_TYPES]),
					gte(jobs.created_at, since),
				),
			);
		used = Number(row?.c ?? 0);
	} catch (err) {
		// Fail-open — never block a real user on a counter/DB hiccup — but never silently.
		raisePlatformAbuseAlert({
			event: COST_GUARD_FAILED_OPEN_EVENT,
			subject: "free_daily_jobs",
			title: "Free job quota check failed open",
			summary: `The free daily job quota could not count an organization's jobs, so a job was admitted without the ${cap}-a-day cap. Error: ${err instanceof Error ? err.message : String(err)}`,
			severity: "critical",
		});
		return;
	}

	if (used < cap) return;

	throw new UsageLimitError(
		`The Hobby plan allows ${cap} provisioning jobs per day. You've hit the limit — it clears over the next 24 hours, or upgrade to remove it.`,
		true,
	);
}
