// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe webhook — the single write path that flips an org's entitlements AND the
// trigger for Alethia's branded billing emails (receipt / dunning / trial / cancel /
// credit pack). Verifies the signature, then maps subscription lifecycle events onto
// the org's organization_billing record (idempotent on organization_id). Entitlements
// resolve fresh from that record on the next request (getActiveScope), so no cache to bust.
//
// Exactly-once: state upserts are idempotent, but emails are NOT — and Stripe retries /
// duplicates deliveries. So every event is claimed in stripe_webhook_event first; an
// already-`done` event is acknowledged (200) without re-running, so no double-sends.
//
// The org an event belongs to is carried as subscription.metadata.organization_id
// (set by the checkout server action). Events without it are ignored (logged), so a
// stray Stripe object can never mutate the wrong tenant.

import type Stripe from "stripe";
import { captureServer } from "@/lib/analytics/server";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import { grantAiCredits } from "@/lib/billing/ai-quota";
import { getStripeConfig, isStripeConfigured } from "@/lib/billing/config";
import { mirrorPaidInvoice, setInvoiceStatus } from "@/lib/billing/invoices";
import { attemptBackupPayment } from "@/lib/billing/payment-methods";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	claimWebhookEvent,
	markWebhookEventDone,
	markWebhookEventError,
} from "@/lib/billing/webhook-events";
import {
	sendCreditPackReceiptEmail,
	sendPaymentFailedEmail,
	sendReceiptEmail,
	sendSubscriptionCanceledEmail,
	sendTrialEndingEmail,
} from "@/lib/email/billing-email";

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
 * Dispatches a single verified Stripe event: syncs billing state and sends the
 * matching branded email. Email sends are wrapped so a mail failure logs but never
 * fails the webhook — the state write has already committed and the event is marked
 * done (Stripe should not retry just because an email hiccuped).
 */
async function handleEvent(event: Stripe.Event): Promise<void> {
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
			// One-time AI credit-pack invoice → grant rollover credits (idempotent on the
			// invoice id) + a branded receipt with the compliant invoice PDF attached.
			if (invoice.metadata?.product_type === "ai_credits" && invoice.id) {
				const orgId = invoice.metadata.organization_id;
				const userId = invoice.metadata.user_id;
				const credits = Number(invoice.metadata.credits ?? 0);
				if (orgId && userId && credits > 0) {
					await grantAiCredits({ orgId, userId, credits, stripeRef: invoice.id });
					// Mirror the paid invoice locally (idempotent) so it shows on the billing
					// page — best-effort, never fails the webhook.
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
				// Revenue truth: the trial→paid / renewed moment, on the org group.
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
			// Re-sync (status past_due), then try failing over to a backup card BEFORE
			// dunning — only if no backup pays do we email the "update your card" prompt.
			const invoice = event.data.object;
			const sub = await subForInvoice(invoice);
			if (sub) {
				await syncSubscriptionToBilling(sub);
				const customerId =
					typeof sub.customer === "string" ? sub.customer : sub.customer.id;
				const failedPm = paymentMethodIdOf(invoice);
				const paid = invoice.id
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
			// A finalized/paid invoice was voided upstream → reflect it in our mirror. (A
			// refund, by contrast, doesn't change an invoice's status in Stripe's model — it
			// surfaces in the transactions/charges ledger — so there's no charge.refunded
			// case here.)
			const invoice = event.data.object;
			if (invoice.id) await setInvoiceStatus(invoice.id, "void");
			break;
		}
		default:
			// Unhandled event types are acknowledged (200) so Stripe stops retrying.
			break;
	}
}

/**
 * Fires a revenue event to PostHog on the org group (best-effort). distinct_id = the person who set up
 * billing (`created_by` on the sub/customer metadata) when known, else the org id so it still lands on
 * the org group. Only fires for org-scoped subscriptions (ignores bare owner-only customers).
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

/** Runs an email send, swallowing (logging) failures so they never fail the webhook. */
async function safeEmail(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		console.error(`[stripe] ${label} email failed:`, err);
	}
}

/** Mirrors a paid invoice locally, swallowing (logging) failures — the entitlement sync
 *  has already committed, so a mirror/PDF hiccup must never fail the webhook. */
async function safeMirror(
	invoice: Stripe.Invoice,
	orgId: string,
): Promise<void> {
	try {
		await mirrorPaidInvoice(invoice, orgId);
	} catch (err) {
		console.error(`[stripe] invoice mirror failed for ${invoice.id}:`, err);
	}
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

	// Exactly-once claim: skip an already-processed delivery (no double emails).
	const claim = await claimWebhookEvent(event.id, event.type);
	if (!claim.claimed && claim.alreadyDone) {
		return Response.json({ received: true, duplicate: true });
	}

	try {
		await handleEvent(event);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[stripe] handler error for ${event.type}:`, err);
		await markWebhookEventError(event.id, message);
		return new Response("handler error", { status: 500 });
	}

	await markWebhookEventDone(event.id);
	return Response.json({ received: true });
}
