// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan's monthly "Included credit" (catalog `includedCreditUsd`) made real, via
// Stripe Billing credit grants: a monetary credit scoped to metered prices that draws
// down before the customer is invoiced for overage. Granted once per billing period
// (idempotent on the period), expiring at period end so unused credit doesn't roll over.
// Driven from syncSubscriptionToBilling, so it's created on activation and re-created
// each period when the subscription renews. Best-effort — a grant failure never breaks
// the billing sync.
//
// NOTE (ops): when the runner-minutes meter is enabled (STRIPE_PRICE_METER_TEAM), its
// price must NOT also carry a graduated free tier, or the org gets the free tier AND the
// credit (double allowance). The credit is the single "first $X free" mechanism.

import type Stripe from "stripe";
import { isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { planFromSubscription, planItem } from "@/lib/billing/sync";
import { planMeta } from "@repo/plan-catalog";

/**
 * Ensures the subscription's current period has its plan's included usage credit (a
 * Stripe monetary credit grant scoped to metered usage). No-op unless Stripe is wired,
 * the sub is active, the plan has an `includedCreditUsd`, and no grant for this period
 * exists yet. Best-effort: errors are logged, never thrown.
 */
export async function ensureIncludedCredit(sub: Stripe.Subscription): Promise<void> {
	try {
		if (!isStripeConfigured()) return;
		if (sub.status !== "active") return;

		const orgId = sub.metadata?.organization_id;
		if (!orgId) return;

		// `planItem`, NOT `items.data[0]` (#4655). This function exists BECAUSE the runner-minutes
		// meter is enabled (see the ops note above), so the subscription it is handed carries two
		// items — and the Stripe API does not promise `items.data` in creation order. Off position 0
		// the meter price resolves to no plan, so the org silently gets zero included credit, and
		// the grant's expiry and period key come off the meter's period rather than the plan's.
		const item = planItem(sub);
		if (!item && sub.items.data.length > 0) {
			// Loud rather than silent, as syncSubscriptionToBilling is: everything below now resolves
			// from metadata.plan alone, and the grant loses its expiry and its period key. Guessing
			// the plan from a meter price instead is the same defect wearing a different name.
			console.warn(
				`[billing] subscription ${sub.id} carries ${sub.items.data.length} item(s) and none is a ` +
					"licensed plan line — resolving the included credit from metadata.plan only",
			);
		}
		// Resolve from metadata.plan first (like syncSubscriptionToBilling): an Enterprise
		// subscription is on a CUSTOM negotiated price whose id isn't in the STRIPE_PRICE_* map,
		// so planForPriceId alone returns null and the org would silently get zero included credit.
		const plan = planFromSubscription(sub, item?.price.id);
		if (!plan) return;
		const usd = planMeta(plan).includedCreditUsd ?? 0;
		if (usd <= 0) return;

		const periodEnd = item?.current_period_end;
		const periodKey = String(item?.current_period_start ?? "");
		const customerId =
			typeof sub.customer === "string" ? sub.customer : sub.customer.id;

		const stripe = getStripe();
		// Idempotent per period — skip if this period's grant already exists.
		const existing = await stripe.billing.creditGrants.list({
			customer: customerId,
			limit: 100,
		});
		if (
			existing.data.some(
				(g) =>
					g.metadata?.period === periodKey &&
					g.metadata?.organization_id === orgId,
			)
		) {
			return;
		}

		await stripe.billing.creditGrants.create({
			customer: customerId,
			name: `${planMeta(plan).name} included credit`,
			category: "promotional",
			amount: {
				type: "monetary",
				monetary: { currency: "usd", value: Math.round(usd * 100) },
			},
			applicability_config: { scope: { price_type: "metered" } },
			...(periodEnd ? { expires_at: periodEnd } : {}),
			metadata: { period: periodKey, organization_id: orgId },
		});
	} catch (e) {
		console.error("[billing] included-credit grant failed:", e);
	}
}
