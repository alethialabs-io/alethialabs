// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getOrgBilling } from "@/lib/billing/queries";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliBillingResponse } from "@/lib/validations/cli-contract";

/**
 * Reads the active org's billing state: the resolved plan/status, the purchased seat
 * count, the Stripe subscription id, and the trial / current-period boundaries. A
 * client-safe projection of the `organization_billing` row (no customer ids or amounts).
 * Read-only and visible to any member, so gated on `view` of `org` (mirrors getBillingSummary,
 * which is "any member"). Org-scoped: the personal scope (no org row) reads as community.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		// The personal scope (orgId === userId) never has a billing row → community defaults.
		const billing =
			actor.orgId === actor.userId ? null : await getOrgBilling(actor.orgId);
		const status = billing?.status ?? "none";
		// We don't store a trial_ends_at column; a `trialing` subscription's trial ends at the
		// current period end, so surface that (null otherwise).
		const periodEnd = billing?.currentPeriodEnd?.toISOString() ?? null;

		return cliJson(cliBillingResponse, {
			billing: {
				plan: billing?.plan ?? "community",
				status,
				seats: billing?.seats ?? null,
				stripe_subscription_id: billing?.stripeSubscriptionId ?? null,
				trial_ends_at: status === "trialing" ? periodEnd : null,
				current_period_end: periodEnd,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
