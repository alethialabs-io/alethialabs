// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe webhook event dispatcher, extracted from app/api/webhooks/stripe/route.ts so it can be
// re-run by the break-glass "replay webhook" recovery action against the exact same idempotent code
// path. State writes here are idempotent (subscription sync upserts on organization_id; credit
// grants are idempotent on the invoice id) — the ONLY non-idempotent side effect is the branded
// emails, which is why the live webhook guards on stripe_webhook_event. A replay passes
// `suppressEmails: true` so re-dispatching an already-delivered event never re-mails the customer.

import type Stripe from "stripe";
import { captureServer } from "@/lib/analytics/server";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import { grantAiCredits } from "@/lib/billing/ai-quota";
import { mirrorPaidInvoice, setInvoiceStatus } from "@/lib/billing/invoices";
import { attemptBackupPayment } from "@/lib/billing/payment-methods";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	sendCreditPackReceiptEmail,
	sendPaymentFailedEmail,
	sendReceiptEmail,
	sendSubscriptionCanceledEmail,
	sendTrialEndingEmail,
} from "@/lib/email/billing-email";

/** Options controlling side effects of a dispatch. */
export interface HandleEventOptions {
	/** When true, skip all branded emails (used by break-glass replay so a re-run never re-mails). */
	suppressEmails?: boolean;
	/**
	 * When true, skip the OUTWARD payment retry (attemptBackupPayment) on invoice.payment_failed. A
	 * break-glass REPLAY re-processes a stored event's STATE — it must not re-attempt a live charge on
	 * a customer's backup card. Default-on for replay; an operator can explicitly opt back in.
	 */
	suppressPaymentRetry?: boolean;
}

/** The default payment method id on an invoice (the card that was charged), or null. */
function paymentMethodIdOf(invoice: Stripe.Invoice): string | null {
	const ref = invoice.default_payment_method;
	if (!ref) return null;
	return typeof ref === "string" ? ref : ref.id;
}

/** Retrieves the subscription an invoice belongs to, or null (e.g. one-off invoices). */
async function subForInvoice(
	invoice: Stripe.Invoice,
): Promise<Stripe.Subscription | null> {
	const subRef = invoice.parent?.subscription_details?.subscription;
	const subId = typeof subRef === "string" ? subRef : subRef?.id;
	return subId ? await getStripe().subscriptions.retrieve(subId) : null;
}

/**
 * Fires a revenue event to PostHog on the org group (best-effort). distinct_id = the person who set
 * up billing (`created_by` on the sub/customer metadata) when known, else the org id so it still
 * lands on the org group. Only fires for org-scoped subscriptions.
 */
async function trackRevenue(
	sub: Stripe.Subscription,
	event: AnalyticsEvent,
	props?: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
	const orgId = sub.metadata?.organization_id;
	if (!orgId) return;
	const distinctId = sub.metadata?.created_by || orgId;
	await captureServer(distinctId, event, orgId, props);
}

/**
 * Dispatches a single verified Stripe event: syncs billing state and (unless suppressed) sends the
 * matching branded email. Email sends are wrapped so a mail failure logs but never fails the caller;
 * the state write has already committed.
 */
export async function handleStripeEvent(
	event: Stripe.Event,
	opts: HandleEventOptions = {},
): Promise<void> {
	// Runs an email send, swallowing (logging) failures; a no-op when suppressed (replay path).
	const safeEmail = async (label: string, fn: () => Promise<void>): Promise<void> => {
		if (opts.suppressEmails) return;
		try {
			await fn();
		} catch (err) {
			console.error(`[stripe] ${label} email failed:`, err);
		}
	};
	// Mirrors a paid invoice locally, swallowing (logging) failures — the entitlement sync has
	// already committed, so a mirror/PDF hiccup must never fail the caller.
	const safeMirror = async (
		invoice: Stripe.Invoice,
		orgId: string,
	): Promise<void> => {
		try {
			await mirrorPaidInvoice(invoice, orgId);
		} catch (err) {
			console.error(`[stripe] invoice mirror failed for ${invoice.id}:`, err);
		}
	};

	switch (event.type) {
		case "customer.subscription.created":
		case "customer.subscription.updated":
			await syncSubscriptionToBilling(event.data.object);
			break;
		case "customer.subscription.deleted": {
			const sub = event.data.object;
			await syncSubscriptionToBilling(sub);
			await trackRevenue(sub, "subscription_canceled");
			await safeEmail("subscription canceled", () =>
				sendSubscriptionCanceledEmail(sub),
			);
			break;
		}
		case "customer.subscription.trial_will_end":
			await safeEmail("trial will end", () =>
				sendTrialEndingEmail(event.data.object),
			);
			break;
		case "checkout.session.completed": {
			// First purchase: pull the full subscription, then apply.
			const session = event.data.object;
			if (typeof session.subscription === "string") {
				await syncSubscriptionToBilling(
					await getStripe().subscriptions.retrieve(session.subscription),
				);
			}
			break;
		}
		case "invoice.payment_succeeded": {
			const invoice = event.data.object;
			// One-time AI credit-pack invoice → grant rollover credits (idempotent on the invoice id)
			// + a branded receipt with the compliant invoice PDF attached.
			if (invoice.metadata?.product_type === "ai_credits" && invoice.id) {
				const orgId = invoice.metadata.organization_id;
				const userId = invoice.metadata.user_id;
				const credits = Number(invoice.metadata.credits ?? 0);
				if (orgId && userId && credits > 0) {
					await grantAiCredits({ orgId, userId, credits, stripeRef: invoice.id });
					await safeMirror(invoice, orgId);
					await safeEmail("credit pack receipt", () =>
						sendCreditPackReceiptEmail(invoice),
					);
				}
				break;
			}
			// Subscription renewal / first payment: re-sync (status active) + receipt w/ PDF.
			const sub = await subForInvoice(invoice);
			if (sub) {
				await syncSubscriptionToBilling(sub);
				const orgId = sub.metadata?.organization_id;
				if (orgId) await safeMirror(invoice, orgId);
				await trackRevenue(sub, "subscription_active", {
					amount: invoice.amount_paid,
					currency: invoice.currency,
					billing_reason: invoice.billing_reason,
				});
				await safeEmail("receipt", () => sendReceiptEmail(sub, invoice));
			}
			break;
		}
		case "invoice.payment_failed": {
			// Re-sync (status past_due), then try failing over to a backup card BEFORE dunning —
			// only if no backup pays do we email the "update your card" prompt.
			const invoice = event.data.object;
			const sub = await subForInvoice(invoice);
			if (sub) {
				await syncSubscriptionToBilling(sub);
				const customerId =
					typeof sub.customer === "string" ? sub.customer : sub.customer.id;
				const failedPm = paymentMethodIdOf(invoice);
				// A replay must not re-attempt a live charge (suppressPaymentRetry); treat it as
				// unpaid so the state re-syncs without touching the customer's backup card.
				const paid =
					invoice.id && !opts.suppressPaymentRetry
						? await attemptBackupPayment(customerId, invoice.id, failedPm).catch(
								() => null,
							)
						: null;
				if (!paid) {
					await trackRevenue(sub, "payment_failed", {
						amount: invoice.amount_due,
						currency: invoice.currency,
					});
					await safeEmail("payment failed", () =>
						sendPaymentFailedEmail(sub, invoice),
					);
				}
			}
			break;
		}
		case "invoice.voided": {
			const invoice = event.data.object;
			if (invoice.id) await setInvoiceStatus(invoice.id, "void");
			break;
		}
		default:
			// Unhandled event types are acknowledged so Stripe stops retrying.
			break;
	}
}
