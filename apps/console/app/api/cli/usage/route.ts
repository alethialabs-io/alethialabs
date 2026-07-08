// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { aiTierSpec, effectiveAiTier } from "@/lib/billing/ai-plan";
import { getOrgBilling } from "@/lib/billing/queries";
import { countBillableSeats } from "@/lib/billing/seats";
import { sumCredits } from "@/lib/billing/ai-quota";
import { getServiceDb } from "@/lib/db";
import { queryJobMinutesByOrg } from "@/lib/queries/runner-usage";
import { queryResourceCounts } from "@/lib/queries/usage-counts";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliUsageResponse } from "@/lib/validations/cli-contract";

/**
 * Reports the active org's current usage: billable seats used vs the purchased cap,
 * managed-runner minutes consumed this period, the project count, and AI credits used in
 * the trailing week vs the plan's weekly grant. A read-only roll-up of the same primitives
 * the console Usage page renders (lib/billing). Gated on `view` of `org` (any member);
 * org-scoped — the personal scope reports zeroes against the community grant.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const hasOrg = actor.orgId !== actor.userId;
		const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;
		// AI is a standalone tier now (independent of the org plan); the CLI reports the
		// tier's weekly credit grant as the AI budget denominator.
		const aiSpec = aiTierSpec(
			effectiveAiTier(
				billing?.aiTier ?? "ai_free",
				billing?.aiSubscriptionStatus ?? "none",
			),
		);

		const now = new Date();
		// Meter from the current paid period start, else the calendar month (matches getOrgUsage).
		const from =
			billing?.currentPeriodStart ??
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		const [seatsUsed, minuteRows, counts, creditsUsed] = await Promise.all([
			hasOrg ? countBillableSeats(actor.orgId) : Promise.resolve(0),
			queryJobMinutesByOrg(getServiceDb(), { from, to: now, orgId: actor.orgId }),
			hasOrg
				? queryResourceCounts(actor.orgId)
				: Promise.resolve({ projects: 0, clusters: 0, spendUnderManagement: 0 }),
			hasOrg ? sumCredits(actor.orgId, "included", weekAgo) : Promise.resolve(0),
		]);

		return cliJson(cliUsageResponse, {
			usage: {
				seats_used: seatsUsed,
				seats_cap: billing?.seats ?? 0,
				runner_minutes: Math.round(minuteRows[0]?.job_minutes ?? 0),
				projects: counts.projects,
				ai_credits_used: Math.round(creditsUsed),
				ai_credits_granted: aiSpec.weeklyCredits,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
