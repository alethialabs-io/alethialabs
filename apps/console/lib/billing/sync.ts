// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single write path that maps a Stripe subscription onto an org's
// organization_billing record (the row that decides entitlements). Idempotent on
// organization_id, so a replayed webhook event and the synchronous post-payment link
// step both converge to the same state. Shared by the Stripe webhook
// (app/api/webhooks/stripe/route.ts) and the new-org link action (server/actions/billing).

import type Stripe from "stripe";
import { effectiveAiTier } from "@/lib/billing/ai-plan";
import { aiTierForPriceId, planForPriceId } from "@/lib/billing/config";
import { ensureIncludedCredit } from "@/lib/billing/credit-grants";
import { isBillingActive } from "@/lib/billing/plan";
import {
	claimPlanWelcome,
	upsertOrgAiSubscription,
	upsertOrgBilling,
} from "@/lib/billing/queries";
import { sendPlanWelcomeEmail } from "@/lib/email/billing-email";
import type { BillingStatus } from "@/lib/db/schema/enums";

/** Stripe subscription.status → our billing_status. */
export function mapStatus(s: Stripe.Subscription.Status): BillingStatus {
	switch (s) {
		case "active":
			return "active";
		case "trialing":
			return "trialing";
		case "past_due":
		case "unpaid":
			return "past_due";
		case "canceled":
		case "incomplete_expired":
			return "canceled";
		default:
			return "none";
	}
}

/**
 * Applies a subscription's current state to its org's billing record, resolving the
 * org from `subscription.metadata.organization_id`. Events without it are ignored
 * (logged), so a stray Stripe object can never mutate the wrong tenant.
 */
export async function syncSubscriptionToBilling(
	sub: Stripe.Subscription,
): Promise<void> {
	const orgId = sub.metadata?.organization_id;
	if (!orgId) {
		console.warn(
			`[stripe] subscription ${sub.id} has no organization_id metadata — ignored`,
		);
		return;
	}
	const item = sub.items.data[0];
	const priceId = item?.price.id;

	// STANDALONE AI subscription (ai_plus/ai_max) — a SEPARATE Stripe product from the org
	// plan. Route it to the AI columns only (never touch plan/seats), then return.
	const aiTier = priceId ? aiTierForPriceId(priceId) : null;
	if (aiTier) {
		await syncAiSubscriptionToBilling(orgId, sub, aiTier);
		return;
	}

	const plan = priceId ? planForPriceId(priceId) : null;
	const status = mapStatus(sub.status);
	// Only a LIVE subscription (active/trialing) grants a paid plan or shows a renewal
	// date. An `incomplete` (→ "none"), `past_due`, or `canceled` sub keeps the org on
	// community — otherwise an UNPAID "upgrade" would light up Pro in the billing panel
	// (and diverge from the app-shell, which already gates the effective plan on
	// isBillingActive). We still retain stripeSubscriptionId/seats so the panel can show
	// and clean up a pending sub; Stripe auto-expires an abandoned incomplete one.
	const live = isBillingActive(status);
	await upsertOrgBilling({
		organizationId: orgId,
		plan: live && plan ? plan : "community",
		status,
		stripeCustomerId:
			typeof sub.customer === "string" ? sub.customer : sub.customer.id,
		stripeSubscriptionId: sub.id,
		seats: item?.quantity ?? null,
		currentPeriodEnd:
			live && item?.current_period_end
				? new Date(item.current_period_end * 1000)
				: null,
	});

	// Grant the plan's monthly included usage credit for this period (idempotent,
	// best-effort). Runs on activation + each renewal sync.
	await ensureIncludedCredit(sub);

	// First time this org reaches a paid plan (trial or paid) → welcome email, exactly
	// once. The claim is atomic (welcomed_at IS NULL), so renewals/updates and racing
	// sync calls never re-send; a mail failure is best-effort (never fails the sync).
	if (status === "active" || status === "trialing") {
		if (await claimPlanWelcome(orgId)) {
			try {
				await sendPlanWelcomeEmail(sub);
			} catch (err) {
				console.error(`[stripe] plan-welcome email failed for ${orgId}:`, err);
			}
		}
	}
}

/**
 * Applies a standalone AI subscription's state to its org's AI columns only. A live
 * (active/trialing) subscription keeps the paid `ai_tier`; anything else lapses the org
 * back to `ai_free` (effectiveAiTier) while retaining the subscription id so the panel can
 * show/clean up a pending sub. The org plan is untouched — AI is orthogonal.
 */
async function syncAiSubscriptionToBilling(
	orgId: string,
	sub: Stripe.Subscription,
	tier: "ai_plus" | "ai_max",
): Promise<void> {
	const status = mapStatus(sub.status);
	await upsertOrgAiSubscription({
		organizationId: orgId,
		aiTier: effectiveAiTier(tier, status),
		aiSubscriptionStatus: status,
		aiStripeSubscriptionId: sub.id,
	});
}
