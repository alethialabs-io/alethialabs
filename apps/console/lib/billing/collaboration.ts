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

import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling, resolveOrgEntitlements } from "@/lib/billing/queries";

/**
 * Whether `orgId` may invite members: true on a live subscription (active or a free
 * trial), false for no subscription. Not billing-gated on self-managed/licensed
 * instances (no Stripe).
 */
export async function canOrgInvite(orgId: string): Promise<boolean> {
	if (!isStripeConfigured()) return true;
	const billing = await getOrgBilling(orgId);
	if (!billing) return false;
	return billing.status === "active" || billing.status === "trialing";
}

/**
 * Whether `orgId` may create teams — an Enterprise-tier capability. Resolved from the
 * org's billing-backed entitlements (`teams`), so an unsubscribed/community org is
 * denied. Injected into ee/ via `CoreContext.canOrgCreateTeams` and enforced in the
 * organization plugin's `beforeCreateTeam` hook (the UI shows the upsell separately).
 */
export async function canOrgCreateTeams(orgId: string): Promise<boolean> {
	return (await resolveOrgEntitlements(orgId)).teams;
}
