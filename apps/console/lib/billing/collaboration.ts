// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "can this org invite teammates?" gate. Collaboration is unlocked by a live Pro
// subscription — paid (active) OR a free trial (trialing), Vercel-style: inviting during
// the trial is free (every seat is $0 until trial_end regardless of quantity; syncOrgSeats
// keeps the quantity in step so per-seat billing applies only after the trial converts).
// Used both as the UI signal (getCollaborationAccess server action) and as the server-side
// enforcement in the org plugin's beforeCreateInvitation hook (injected into ee/ via
// CoreContext.canOrgInvite). Self-managed / licensed instances have no Stripe billing, so
// they are never gated here.

import { isBillingConfigured, isStripeConfigured } from "@/lib/billing/config";
import { isManualGrantExpired } from "@/lib/billing/plan";
import type { Entitlements } from "@/lib/authz/types";
import { getOrgBilling, resolveOrgEntitlements } from "@/lib/billing/queries";

/**
 * Whether `orgId` may invite members: true on a live subscription (active or a free
 * trial), false for no subscription. Not billing-gated on self-managed/licensed
 * instances (no Stripe).
 */
export async function canOrgInvite(orgId: string): Promise<boolean> {
	// Hosted means either rail: Stripe, or a configured sales provider (Paddle).
	if (!isStripeConfigured() && !isBillingConfigured()) return true;
	const billing = await getOrgBilling(orgId);
	if (!billing) return false;
	// A local trial or contract grant past its term no longer counts (`isManualGrantExpired`).
	if (isManualGrantExpired(billing)) return false;
	return billing.status === "active" || billing.status === "trialing";
}

/**
 * Whether `orgId` may create teams — an Enterprise-tier capability: true only when the
 * organization's entitlements carry `teams`. `resolve` names where those entitlements come
 * from. Its default is the organization's billing record, so an unsubscribed/community org is
 * denied. The enterprise module passes its own resolver, which answers from the instance licence
 * when one grants and from the same billing record otherwise, so an instance licensed as a
 * whole is not asked for a billing row it never has. Injected into ee/ via
 * `CoreContext.canOrgCreateTeams` and enforced in the organization plugin's `beforeCreateTeam`
 * hook (the UI shows the upsell separately).
 */
export async function canOrgCreateTeams(
	orgId: string,
	resolve: (orgId: string) => Promise<Entitlements> = resolveOrgEntitlements,
): Promise<boolean> {
	return (await resolve(orgId)).teams === true;
}
