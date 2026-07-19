// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Free-tier daily job quota — the VOLUME half of the fleet cost ceiling (the concurrency cap +
// global instance ceiling bound instantaneous cost; this bounds cumulative enqueues). Called by the
// USER-facing enqueue paths (server actions + CLI job routes) right before inserting a job, next to
// assertUsageAllowed. SYSTEM enqueues (reconcile / drift / probe / ephemeral-reaper / auto-heal /
// build-chain) run on getServiceDb() with no actor and never call this guard, so auto-reconcile is
// never throttled — and, doubly, the count only tallies rows stamped `initiated_by = 'user'`.

import "server-only";
import { and, count, eq, gte } from "drizzle-orm";
import { getOrgBilling } from "@/lib/billing/queries";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** Default trailing-24h cap on USER-initiated job enqueues for free/community orgs. */
export const DEFAULT_FREE_DAILY_JOB_QUOTA = 25;

/**
 * Configured trailing-24h user-job cap (env override `ALETHIA_FREE_DAILY_JOB_QUOTA`). Unset/blank
 * arrives as "" → Number("") = 0 (not > 0) → falls back to the default; a non-positive or
 * non-numeric override is likewise ignored rather than trusted.
 */
export function freeDailyJobQuota(): number {
	const raw = Number(process.env.ALETHIA_FREE_DAILY_JOB_QUOTA);
	return Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: DEFAULT_FREE_DAILY_JOB_QUOTA;
}

/**
 * Blocks a new USER-initiated enqueue when a free/community org has already enqueued
 * {@link freeDailyJobQuota} jobs in the trailing 24 hours. Paid orgs (team/enterprise) are
 * unbounded here — their cost is bounded by the concurrency cap + global instance ceiling, and
 * overage bills. Fail-open: a billing- or count-query error must never wedge provisioning, so it
 * returns (allows) rather than throwing on infrastructure failure — this is a soft cost guard, not
 * a security control. Throws {@link UsageLimitError} (upgradable) when the cap is hit.
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
					gte(jobs.created_at, since),
				),
			);
		used = Number(row?.c ?? 0);
	} catch {
		// Fail-open — never block a real user on a counter/DB hiccup.
		return;
	}

	if (used < cap) return;

	throw new UsageLimitError(
		`Free plan allows ${cap} provisioning jobs per day. You've hit the limit — it clears over the next 24 hours, or upgrade to remove it.`,
		true,
	);
}
