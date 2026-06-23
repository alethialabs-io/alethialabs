// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe webhook — the single write path that flips an org's entitlements. Verifies
// the signature, then maps subscription lifecycle events onto the org's
// organization_billing record (idempotent on organization_id). Entitlements resolve
// fresh from that record on the next request (getActiveScope), so no cache to bust.
//
// The org an event belongs to is carried as subscription.metadata.organization_id
// (set by the checkout server action). Events without it are ignored (logged), so a
// stray Stripe object can never mutate the wrong tenant.

import type Stripe from "stripe";
import { grantAiCredits } from "@/lib/billing/ai-quota";
import { getStripeConfig, isStripeConfigured, planForPriceId } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { upsertOrgBilling } from "@/lib/billing/queries";
import type { BillingStatus } from "@/lib/db/schema/enums";

/** Stripe subscription.status → our billing_status. */
function mapStatus(s: Stripe.Subscription.Status): BillingStatus {
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

/** Applies a subscription's current state to its org's billing record. */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
	const orgId = sub.metadata?.organization_id;
	if (!orgId) {
		console.warn(
			`[stripe] subscription ${sub.id} has no organization_id metadata — ignored`,
		);
		return;
	}
	const item = sub.items.data[0];
	const priceId = item?.price.id;
	const plan = priceId ? planForPriceId(priceId) : null;
	const status = mapStatus(sub.status);
	await upsertOrgBilling({
		organizationId: orgId,
		// An unknown/removed price (or a fully canceled sub) drops the org to community.
		plan: plan && status !== "canceled" ? plan : "community",
		status,
		stripeCustomerId:
			typeof sub.customer === "string" ? sub.customer : sub.customer.id,
		stripeSubscriptionId: sub.id,
		seats: item?.quantity ?? null,
		currentPeriodEnd: sub.items.data[0]?.current_period_end
			? new Date(sub.items.data[0].current_period_end * 1000)
			: null,
	});
}

export async function POST(req: Request): Promise<Response> {
	if (!isStripeConfigured()) {
		return new Response("billing not configured", { status: 503 });
	}
	const signature = req.headers.get("stripe-signature");
	if (!signature) return new Response("missing signature", { status: 400 });

	const body = await req.text();
	let event: Stripe.Event;
	try {
		event = await getStripe().webhooks.constructEventAsync(
			body,
			signature,
			getStripeConfig().webhookSecret,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "invalid";
		return new Response(`signature verification failed: ${message}`, {
			status: 400,
		});
	}

	try {
		switch (event.type) {
			case "customer.subscription.created":
			case "customer.subscription.updated":
			case "customer.subscription.deleted":
				await applySubscription(event.data.object);
				break;
			case "checkout.session.completed": {
				// First purchase: pull the full subscription, then apply.
				const session = event.data.object;
				if (typeof session.subscription === "string") {
					const sub = await getStripe().subscriptions.retrieve(
						session.subscription,
					);
					await applySubscription(sub);
				}
				break;
			}
			case "invoice.payment_succeeded":
			case "invoice.payment_failed": {
				// Embedded first-payment / renewal / dunning: re-sync from the invoice's
				// subscription so status (active / past_due) stays accurate.
				const subRef = event.data.object.parent?.subscription_details?.subscription;
				const subId = typeof subRef === "string" ? subRef : subRef?.id;
				if (subId) {
					await applySubscription(await getStripe().subscriptions.retrieve(subId));
				}
				break;
			}
			case "payment_intent.succeeded": {
				// One-time AI credit-pack purchase → grant rollover credits (idempotent).
				const intent = event.data.object;
				if (intent.metadata?.product_type === "ai_credits") {
					const orgId = intent.metadata.organization_id;
					const userId = intent.metadata.user_id;
					const credits = Number(intent.metadata.credits ?? 0);
					if (orgId && userId && credits > 0) {
						await grantAiCredits({ orgId, userId, credits, stripeRef: intent.id });
					}
				}
				break;
			}
			default:
				// Unhandled event types are acknowledged (200) so Stripe stops retrying.
				break;
		}
	} catch (err) {
		console.error(`[stripe] handler error for ${event.type}:`, err);
		return new Response("handler error", { status: 500 });
	}

	return Response.json({ received: true });
}
