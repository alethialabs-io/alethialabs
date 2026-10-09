// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe webhook event dispatcher, extracted from app/api/webhooks/stripe/route.ts so it can be
// re-run by the break-glass "replay webhook" recovery action against the exact same idempotent code
// path. State writes here are idempotent (subscription sync is a guarded upsert carrying the
// event's `created` time, so a replayed event older than the row's watermark is refused; credit
// grants are idempotent on the invoice id) — the ONLY non-idempotent side effect is the branded
// emails, which is why the live webhook guards on stripe_webhook_event. A replay passes
// `suppressEmails: true` so re-dispatching an already-delivered event never re-mails the customer.
//
// PAYMENT HOLDS (ADR 0002 §5.3, S7). The webhook never moves a hold and makes no Stripe call for one:
// it never calls `advanceHold`, whose callers are the sweeper (payment-holds/sweeper.ts `visitHold`) and
// the operator command (scripts/payment-holds.ts), each under the payer's lease. For holds the dispatcher
// only READS `payment_holds` and makes the HINT WRITE (`nudgeHold`: `nudged_at` only, no `version`), and
// it returns how many holds it nudged so the route can wake the sweeper AFTER it has answered Stripe.
// Four rules read holds:
//   1. No backup-card retry on an invoice a hold names (open or released), or on a create-a-team
//      subscription's invoice when that subscription is not live (§5.3 (1), C41, C83).
//   2. No receipt for a held invoice whose subscription reads ended: that payment is being refunded
//      (§5.3 (2), C9, C64). Every invoice no hold names keeps its receipt whatever the status.
//   3. A deletion the machine or the close-out made (stamped in `cancellation_details.comment`) still
//      writes the row, but sends no email and no revenue event (§5.3 (4), C63, C67).
//   4. `invoice.payment_*`, `customer.subscription.updated|deleted` and `charge.refund.updated` nudge the
//      open holds they name (§5.3 (3), C53, C66). A failed nudge is logged and never fails the event:
//      every open hold is also scheduled (I10), so a lost hint only delays the sweeper to its schedule.
// WHAT EACH LOOKUP IS KEYED ON (the live port, `liveWebhookHolds`):
//   heldInvoice            subscription + invoice (the event's own invoice and the subscription it names)
//                          + that subscription's customer.
//   holdNamesSubscription  hold id (from the stamp) + the event's own subscription.
//   nudgeSubscription      the event's own subscription + its customer.
//   nudgeRefund            the hold id in the refund's `alethia_payment_hold` metadata (and, when both the
//                          refund and the hold carry a PaymentIntent, the two must agree), or the refund's
//                          PaymentIntent. A Refund carries no customer, so this one has no customer key.
// Refund metadata is trusted as far as a NUDGE: the event is signature-verified, so the refund is one in
// our own Stripe account, and only our API key or a dashboard user can create a refund or write its
// metadata — a customer cannot. Even a wrong id reaches only `nudged_at`: the sweeper then re-reads Stripe
// for that hold under its own payer's lease and moves it only on what Stripe says. Every other lookup is
// keyed on the event's own subscription, so it cannot read or silence another payer's hold.

import type Stripe from "stripe";
import { captureServer } from "@/lib/analytics/server";
import type { AnalyticsEvent } from "@/lib/analytics/events";
import { grantAiCredits } from "@/lib/billing/ai-quota";
import { mirrorPaidInvoice, setInvoiceStatus } from "@/lib/billing/invoices";
import { attemptBackupPayment } from "@/lib/billing/payment-methods";
import { HOLD_REFUND_METADATA_KEY } from "@/lib/billing/payment-holds/observe";
import { nudgeHold } from "@/lib/billing/payment-holds/store";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	sendCreditPackReceiptEmail,
	sendPaymentFailedEmail,
	sendReceiptEmail,
	sendSubscriptionCanceledEmail,
	sendTrialEndingEmail,
} from "@/lib/email/billing-email";
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { paymentHolds } from "@/lib/db/schema";

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
	/** The payment-hold reads and hint write; the live store unless a test injects one. */
	holds?: WebhookHoldPort;
}

/** What a dispatch did that its caller acts on after responding. */
export interface HandleEventResult {
	/** Open payment holds this event nudged; the route wakes the sweeper when it is above zero. */
	nudged: number;
}

/**
 * Everything the webhook does to `payment_holds` (ADR 0002 §5.3): reads, and the hint write. There is
 * deliberately no state write here — no `version` bump, no lease, no Stripe call.
 */
export interface WebhookHoldPort {
	/**
	 * The hold of `subscriptionId` on `customerId` whose held invoice is `invoiceId`: `open` when an open
	 * hold names it, `released` when only a released one does, null when none does.
	 */
	heldInvoice(subscriptionId: string, invoiceId: string, customerId: string): Promise<HeldInvoice>;
	/** Whether the hold `holdId`, open or released, is the hold of `subscriptionId`. */
	holdNamesSubscription(holdId: string, subscriptionId: string): Promise<boolean>;
	/** Nudges the open holds of `subscriptionId` on `customerId`; returns how many it nudged. */
	nudgeSubscription(subscriptionId: string, customerId: string): Promise<number>;
	/** Nudges the open hold a refund names (its metadata's hold id, or its PaymentIntent); returns the count. */
	nudgeRefund(holdId: string | null, paymentIntentId: string | null): Promise<number>;
}

/** Which hold, if any, names an invoice (see {@link WebhookHoldPort.heldInvoice}). */
export type HeldInvoice = "open" | "released" | null;

/** A hold id is a uuid; anything else names no hold and is never sent to Postgres as one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The open-hold predicate (`state <> 'released'`). */
function openHold(): SQL {
	return ne(paymentHolds.state, "released");
}

/** The live port: one read on `payment_holds` per question, and the store's `nudgeHold` as the only write. */
export const liveWebhookHolds: WebhookHoldPort = {
	async heldInvoice(subscriptionId, invoiceId, customerId) {
		const rows = await getServiceDb()
			.select({ state: paymentHolds.state })
			.from(paymentHolds)
			.where(
				and(
					eq(paymentHolds.subscription_id, subscriptionId),
					eq(paymentHolds.invoice_id, invoiceId),
					eq(paymentHolds.customer_id, customerId),
				),
			);
		if (rows.length === 0) return null;
		return rows.some((r) => r.state !== "released") ? "open" : "released";
	},
	async holdNamesSubscription(holdId, subscriptionId) {
		if (!UUID_RE.test(holdId)) return false;
		const rows = await getServiceDb()
			.select({ id: paymentHolds.id })
			.from(paymentHolds)
			.where(and(eq(paymentHolds.id, holdId), eq(paymentHolds.subscription_id, subscriptionId)))
			.limit(1);
		return rows.length > 0;
	},
	async nudgeSubscription(subscriptionId, customerId) {
		const rows = await getServiceDb()
			.select({ id: paymentHolds.id })
			.from(paymentHolds)
			.where(
				and(
					eq(paymentHolds.subscription_id, subscriptionId),
					eq(paymentHolds.customer_id, customerId),
					openHold(),
				),
			)
			.limit(1);
		return rows.length > 0 ? nudgeHold(subscriptionId) : 0;
	},
	async nudgeRefund(holdId, paymentIntentId) {
		const keys: SQL[] = [];
		if (holdId && UUID_RE.test(holdId)) {
			// A hold that knows its PaymentIntent must agree with the refund's.
			const piAgrees = paymentIntentId
				? or(isNull(paymentHolds.payment_intent_id), eq(paymentHolds.payment_intent_id, paymentIntentId))
				: undefined;
			const byId = and(eq(paymentHolds.id, holdId), piAgrees);
			if (byId) keys.push(byId);
		}
		if (paymentIntentId) keys.push(eq(paymentHolds.payment_intent_id, paymentIntentId));
		if (keys.length === 0) return 0;
		const rows = await getServiceDb()
			.select({ subscriptionId: paymentHolds.subscription_id })
			.from(paymentHolds)
			.where(and(openHold(), or(...keys)));
		let nudged = 0;
		for (const subscriptionId of new Set(rows.map((r) => r.subscriptionId))) {
			nudged += await nudgeHold(subscriptionId);
		}
		return nudged;
	},
};

/** Subscription statuses that are ended (ADR 0002 §2): a payment on one of them is refunded by its hold. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/** Subscription statuses that are live (ADR 0002 §2): the subscription still exists and may bill. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/** The stamp of a close-out's cancel (`closeOutMintedSubscription`, app/server/actions/billing.ts). */
const CLOSEOUT_STAMP = "alethia:closeout";

/** The prefix of the payment-hold machine's cancel stamp, `alethia:checkout_closed:<hold id>` (machine.ts). */
const CHECKOUT_CLOSED_STAMP_PREFIX = "alethia:checkout_closed:";

/**
 * Whether `sub` is a create-a-team subscription (ADR 0002 §2: its own metadata has `created_by` and no
 * `organization_id`) that is not live.
 */
function isUnliveCreateATeamSubscription(sub: Stripe.Subscription): boolean {
	const isCreateATeam = Boolean(sub.metadata?.created_by) && !sub.metadata?.organization_id;
	return isCreateATeam && !LIVE_STATUSES.has(sub.status);
}

/** The id of the customer a subscription belongs to. */
function customerIdOf(sub: Stripe.Subscription): string {
	return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

/**
 * Whether a deletion was made by Alethia itself, not by the customer: the close-out's stamp, or the hold
 * machine's stamp naming a hold that IS this subscription's. The hold-stamp is checked against the table
 * so a comment a customer typed into a cancellation form cannot borrow it; the close-out stamp only ever
 * silences that customer's own email.
 */
async function isAlethiaCancel(sub: Stripe.Subscription, holds: WebhookHoldPort): Promise<boolean> {
	const stamp = sub.cancellation_details?.comment ?? null;
	if (stamp === CLOSEOUT_STAMP) return true;
	if (!stamp?.startsWith(CHECKOUT_CLOSED_STAMP_PREFIX)) return false;
	return holds.holdNamesSubscription(stamp.slice(CHECKOUT_CLOSED_STAMP_PREFIX.length), sub.id);
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
): Promise<HandleEventResult> {
	const holds = opts.holds ?? liveWebhookHolds;
	let nudged = 0;
	// The hint write (§5.3 (3)): logged, never thrown — no event is ever failed because of a hold.
	const nudge = async (fn: () => Promise<number>): Promise<void> => {
		try {
			nudged += await fn();
		} catch (err) {
			console.error(`[stripe] payment-hold nudge failed for ${event.type}:`, err);
		}
	};
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

	// Every subscription sync carries the event's own time. For a subscription.* event it is the
	// time of the snapshot in `data.object`; for an event that RETRIEVES the subscription it is a
	// lower bound on the retrieved state's age — so a stale or redelivered event (including a
	// break-glass replay) is refused rather than regressing the row (#5514).
	const sync = { eventAt: new Date(event.created * 1000) };

	switch (event.type) {
		case "customer.subscription.created":
		case "customer.subscription.updated":
			// Synced from a FRESH retrieve, not the event's snapshot. The row guard can only refuse a
			// stale snapshot of the subscription it already names; a redelivered `active` snapshot of a
			// DIFFERENT, since-cancelled subscription would otherwise claim a row holding nothing live,
			// and stick — every later event for the org's real subscription is then refused. Retrieved,
			// a dead subscription reads `canceled` and claims nothing (#5518 review).
			await syncSubscriptionToBilling(
				await getStripe().subscriptions.retrieve(event.data.object.id),
				sync,
			);
			if (event.type === "customer.subscription.updated") {
				const snapshot = event.data.object;
				await nudge(() => holds.nudgeSubscription(snapshot.id, customerIdOf(snapshot)));
			}
			break;
		case "customer.subscription.deleted": {
			const sub = event.data.object;
			await nudge(() => holds.nudgeSubscription(sub.id, customerIdOf(sub)));
			// A deletion the row refused is a subscription the org is NOT on (an `incomplete` attempt
			// the purchase sweep cancelled, or a second subscription beside the live one). Telling the
			// customer "your subscription was canceled" then would be false, so only the applied
			// deletion reports and mails.
			if ((await syncSubscriptionToBilling(sub, sync)) !== "applied") break;
			// A cancel Alethia made (a hold closing a checkout, or a close-out) is not the customer's: the
			// row still records it, but there was never a plan to tell them was cancelled (§5.3 (4)).
			if (await isAlethiaCancel(sub, holds)) break;
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
					sync,
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
				// A held invoice paid on a subscription that reads ended landed after our cancel, and its
				// hold refunds it (T5): the refund is what the customer is told about, so no receipt and no
				// revenue event. Every other invoice keeps its receipt whatever the status (§5.3 (2)).
				const refundedByHold =
					ENDED_STATUSES.has(sub.status) &&
					Boolean(invoice.id) &&
					(await holds.heldInvoice(sub.id, invoice.id ?? "", customerIdOf(sub))) !== null;
				await syncSubscriptionToBilling(sub, sync);
				const orgId = sub.metadata?.organization_id;
				if (orgId) await safeMirror(invoice, orgId);
				if (!refundedByHold) {
					await trackRevenue(sub, "subscription_active", {
						amount: invoice.amount_paid,
						currency: invoice.currency,
						billing_reason: invoice.billing_reason,
					});
					await safeEmail("receipt", () => sendReceiptEmail(sub, invoice));
				}
				await nudge(() => holds.nudgeSubscription(sub.id, customerIdOf(sub)));
			}
			break;
		}
		case "invoice.payment_failed": {
			// Re-sync (status past_due), then try failing over to a backup card BEFORE dunning —
			// only if no backup pays do we email the "update your card" prompt.
			const invoice = event.data.object;
			const sub = await subForInvoice(invoice);
			if (sub) {
				// Read BEFORE any write (§5.3 (1)). A held invoice is one a hold is closing or has closed, so
				// paying it with a backup card is us charging a checkout we are cancelling. A create-a-team
				// subscription that is not live is either ended (we or Stripe cancelled it; its invoice may
				// still be open, S1) or still `incomplete` — a first payment the customer is confirming in the
				// sheet with the card THEY chose, which may also be about to get a hold. Neither is ours to
				// pay with another card. A read that throws fails the event before any charge, and Stripe
				// redelivers it.
				const held: HeldInvoice = invoice.id
					? await holds.heldInvoice(sub.id, invoice.id, customerIdOf(sub))
					: null;
				const noRetry = isUnliveCreateATeamSubscription(sub) || held !== null;
				await syncSubscriptionToBilling(sub, sync);
				const customerId = customerIdOf(sub);
				const failedPm = paymentMethodIdOf(invoice);
				// A replay must not re-attempt a live charge (suppressPaymentRetry); treat it as
				// unpaid so the state re-syncs without touching the customer's backup card.
				const paid =
					invoice.id && !opts.suppressPaymentRetry && !noRetry
						? await attemptBackupPayment(customerId, invoice.id, failedPm).catch(
								() => null,
							)
						: null;
				if (!paid) {
					await trackRevenue(sub, "payment_failed", {
						amount: invoice.amount_due,
						currency: invoice.currency,
					});
					// Not for an invoice an OPEN hold names (maintainer ruling on #5807): "update your card"
					// invites a retry while the hold is still deciding whether the first payment went through,
					// and the hold's own emails (the sweeper's, Q3) speak for that subscription. An invoice no
					// open hold names keeps the email exactly as before.
					if (held !== "open") {
						await safeEmail("payment failed", () =>
							sendPaymentFailedEmail(sub, invoice),
						);
					}
				}
				await nudge(() => holds.nudgeSubscription(sub.id, customerId));
			}
			break;
		}
		case "invoice.voided": {
			const invoice = event.data.object;
			if (invoice.id) await setInvoiceStatus(invoice.id, "void");
			break;
		}
		case "charge.refund.updated": {
			// A hold's refund changed (e.g. failed, or went `requires_action`): the hold's next observe
			// should see it within minutes rather than at its schedule. The refunds a hold makes carry
			// its id in their metadata (machine.ts); the PaymentIntent matches a hold opened with one.
			const refund = event.data.object;
			const piRef = refund.payment_intent;
			const paymentIntentId = typeof piRef === "string" ? piRef : (piRef?.id ?? null);
			const holdId = refund.metadata?.[HOLD_REFUND_METADATA_KEY] ?? null;
			await nudge(() => holds.nudgeRefund(holdId, paymentIntentId));
			break;
		}
		default:
			// Unhandled event types are acknowledged so Stripe stops retrying.
			break;
	}
	return { nudged };
}
