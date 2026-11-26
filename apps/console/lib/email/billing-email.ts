// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Branded billing emails, sent from the Stripe webhook. Alethia owns the customer
// email experience (receipt / dunning / trial / cancellation / credit pack) via SES
// rather than Stripe's default emails. Each fn maps the Stripe object(s) the webhook
// already holds onto a react-email template and sends through the suppression-aware
// guard on the general stream. The receipt carries the фактура as its attachment when one was
// issued, and otherwise says the invoice follows: Stripe's PDF is never sent as the invoice
// (EA-7b, #7338).

import type Stripe from "stripe";
import { formatDate, formatMoney } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { getEmailConfig } from "@repo/email/config";
import type { EmailAttachment } from "@repo/email/send";
import { and, asc, eq } from "drizzle-orm";
import { issuedFacturaFor } from "@/lib/billing/factura/issue";
import { getStripe } from "@/lib/billing/stripe";
import { planFromSubscription, planItem } from "@/lib/billing/sync";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import { member, organization, user } from "@/lib/db/schema";
import { CreditPackReceiptEmail, subject as creditPackSubject } from "@/emails/credit-pack-receipt";
import { PaymentFailedEmail, subject as paymentFailedSubject } from "@/emails/payment-failed";
import { ReceiptEmail, subject as receiptSubject } from "@/emails/receipt";
import {
	OrderConfirmationEmail,
	subject as orderConfirmationSubject,
} from "@/emails/order-confirmation";
import {
	SubscriptionCanceledEmail,
	subject as canceledSubject,
} from "@/emails/subscription-canceled";
import { TrialEndedEmail, subject as trialEndedSubject } from "@/emails/trial-ended";
import { TrialEndingEmail, subject as trialEndingSubject } from "@/emails/trial-ending";
import {
	WelcomeToPlanEmail,
	subject as planWelcomeSubject,
} from "@/emails/welcome-to-plan";
import { BillingLegal, type FeatureRow } from "@/emails/billing-shared";
import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { text as textStyle } from "@repo/email/components/theme";
import { createElement } from "react";
import type { PaymentHoldNotifiedState } from "@/lib/db/schema";
import { sendGuardedEmail } from "./guard";

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Formats a Stripe smallest-unit amount as currency, e.g. (5800, "usd") → "$58.00".
 *
 * Through `@repo/format`'s `formatMoney` rather than its own `Intl.NumberFormat` (#4176). The local
 * copy divided by 100 unconditionally, so a zero-decimal invoice (¥124,000 is `amount_paid: 124000`)
 * would have been emailed as `¥1,240` — and on `en-US` against the billing page's `en-GB`, so the
 * one money surface a customer keeps could disagree with the console about the same invoice.
 * `formatMoney` takes the divisor from Stripe's own zero-decimal list (`minor-units.ts`).
 */
function money(amountMinor: number, currency: string): string {
	return formatMoney(amountMinor, currency);
}

/**
 * Formats a Stripe unix timestamp (seconds) as e.g. "3 Jul 2026".
 *
 * Through `@repo/format` rather than its own `toLocaleDateString`: a renewal date in a billing
 * email and the same date on the billing page are one fact, and the console had them on two
 * locales — this one pinned `en-US`, `formatDate` pins `en-GB`.
 */
function fmtDate(unixSeconds: number): string {
	return formatDate(unixSeconds * 1000);
}

/** "3 Jul 2026 – 3 Aug 2026" from two unix timestamps; undefined if either is missing. */
function fmtPeriod(startSec?: number | null, endSec?: number | null): string | undefined {
	if (!startSec || !endSec) return undefined;
	return `${fmtDate(startSec)} – ${fmtDate(endSec)}`;
}

// ── Subscription-item resolution ────────────────────────────────────────────

/**
 * The subscription's PLAN-bearing (licensed) line, warning when a subscription that HAS items
 * carries none — everything the emails read off it then falls back to `metadata.plan`.
 *
 * Wraps `planItem` (lib/billing/sync.ts) so every email asks the one question in the one place.
 * NOT `items.data[0]` (#4655): a subscription created while `STRIPE_PRICE_METER_TEAM` is set
 * carries a flat plan line AND a metered runner-minutes line, and the Stripe API does not promise
 * `items.data` in creation order. Read position 0 and, whenever the meter is listed first, the
 * receipt names the wrong plan and the cancellation email quotes the meter's period end as the
 * date the customer loses access.
 *
 * The `undefined` case deliberately has NO positional fallback: a meter price is not a plan
 * price, and naming a plan from one is the defect restated. `planFromSubscription` resolves from
 * `metadata.plan` instead, which is also what carries Enterprise (sold on a custom negotiated
 * price that no `STRIPE_PRICE_*` entry maps).
 *
 * The warning can appear twice for one email — the cancellation email asks once for the plan name
 * and once for the period end. Both lines name the subscription, so the repeat is noise rather
 * than a second finding; de-duplicating it is not worth threading the item through the senders.
 */
function emailPlanItem(sub: Stripe.Subscription): Stripe.SubscriptionItem | undefined {
	const item = planItem(sub);
	if (!item && sub.items.data.length > 0) {
		console.warn(
			`[billing-email] subscription ${sub.id} carries ${sub.items.data.length} item(s) and ` +
				"none is a licensed plan line — naming the plan from metadata.plan only",
		);
	}
	return item;
}

/**
 * Display plan name ("Pro"/"Enterprise"/…) for a subscription.
 *
 * Through `planFromSubscription` rather than `planForPriceId` alone: that is the resolution every
 * other billing surface uses, it honours `metadata.plan`, and it is what `sendPlanWelcomeEmail`
 * below already did — so two emails about one subscription can no longer name two different plans.
 */
function planLabelFromSub(sub: Stripe.Subscription): string {
	return planMeta(planFromSubscription(sub, emailPlanItem(sub)?.price.id) ?? "team").name;
}

// ── Resolution helpers ──────────────────────────────────────────────────────

/** The org's display name for the email body, or a neutral fallback. */
async function orgName(orgId: string | undefined): Promise<string> {
	if (!orgId) return "your organization";
	const [row] = await getServiceDb()
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	return row?.name ?? "your organization";
}

/** The org owner's email (earliest owner membership) — the welcome recipient off the Stripe path. */
async function ownerEmail(orgId: string | undefined): Promise<string | null> {
	if (!orgId) return null;
	const [row] = await getServiceDb()
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
		.orderBy(asc(member.createdAt))
		.limit(1);
	return row?.email ?? null;
}

/** Resolves the billing recipient — a known email wins, else the Stripe customer's. */
async function recipient(
	customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
	knownEmail?: string | null,
): Promise<string | null> {
	if (knownEmail) return knownEmail;
	if (!customer) return null;
	if (typeof customer !== "string") {
		return "email" in customer ? (customer.email ?? null) : null;
	}
	const c = await getStripe().customers.retrieve(customer);
	return c.deleted ? null : (c.email ?? null);
}

/** What a receipt says about the invoice: the фактура to attach and its number, when one exists. */
interface ReceiptInvoice {
	/** The фактура PDF to attach, or null when none was issued. */
	attachment: EmailAttachment | null;
	/** The фактура number (ten Arabic digits), or undefined when none was issued. */
	number: string | undefined;
}

/**
 * The invoice a receipt carries: the фактура (Art. 113-114 ЗДДС) or NOTHING (EA-7b, #7338).
 *
 * There is no Stripe fallback, on purpose. Stripe's PDF is not a compliant фактура (its number is
 * Stripe's `PREFIX-0031` series, not the ten-digit sequence Art. 114(1) requires), and attached as
 * `Invoice-<n>.pdf` it would be the document the customer files as the invoice.
 *
 * The receipt never ISSUES one. The webhook mirrors the invoice first (`mirrorPaidInvoice`, which
 * issues the фактура through lib/billing/factura/issue.ts), and the receipt attaches what that
 * issued. When nothing was issued (the recipient's details are incomplete, no EUR rate, a store
 * failure), the receipt goes out WITHOUT an attachment and says the invoice follows; the invoice
 * row stays pending and the operator alert the mirror raised drives the retry.
 *
 * The number is the фактура's too, never `invoice.number`: Stripe's number printed next to
 * "Invoice" makes the same false claim as the PDF.
 */
async function receiptInvoice(invoice: Stripe.Invoice): Promise<ReceiptInvoice> {
	let factura: Awaited<ReturnType<typeof issuedFacturaFor>> = null;
	try {
		factura = invoice.id ? await issuedFacturaFor(invoice.id) : null;
	} catch {
		// Best-effort: a failure here must never block the receipt itself.
		factura = null;
	}
	if (!factura) return { attachment: null, number: undefined };
	return {
		attachment: {
			filename: `Invoice-${factura.number}.pdf`,
			content: factura.pdf,
			contentType: "application/pdf",
		},
		number: factura.number,
	};
}

// ── Senders (called by the Stripe webhook) ──────────────────────────────────

/** Receipt for a successful subscription payment, with the фактура attached when one was issued. */
export async function sendReceiptEmail(
	sub: Stripe.Subscription,
	invoice: Stripe.Invoice,
): Promise<void> {
	// No receipt for $0 invoices (e.g. a card-less trial's opening invoice).
	if (invoice.amount_paid <= 0) return;
	const to = await recipient(invoice.customer, invoice.customer_email);
	if (!to) return;
	const orgId = sub.metadata?.organization_id;
	const planLabel = planLabelFromSub(sub);
	const amountLabel = money(invoice.amount_paid, invoice.currency);
	const doc = await receiptInvoice(invoice);
	const props = {
		orgName: await orgName(orgId),
		planLabel,
		amountLabel,
		periodLabel: fmtPeriod(invoice.period_start, invoice.period_end),
		invoiceNumber: doc.number,
		invoiceAttached: doc.attachment !== null,
	};
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: receiptSubject({ amountLabel }),
		react: ReceiptEmail(props),
		attachments: doc.attachment ? [doc.attachment] : undefined,
		devLog: `receipt ${amountLabel} for ${props.orgName}`,
	});
}

/** Dunning email when a subscription payment fails. */
export async function sendPaymentFailedEmail(
	sub: Stripe.Subscription,
	invoice: Stripe.Invoice,
): Promise<void> {
	const to = await recipient(invoice.customer, invoice.customer_email);
	if (!to) return;
	const orgId = sub.metadata?.organization_id;
	const amountLabel = money(invoice.amount_due, invoice.currency);
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: paymentFailedSubject,
		react: PaymentFailedEmail({
			orgName: await orgName(orgId),
			amountLabel,
			nextAttemptLabel: invoice.next_payment_attempt
				? fmtDate(invoice.next_payment_attempt)
				: undefined,
		}),
		devLog: `payment failed ${amountLabel}`,
	});
}

/**
 * The subscription's customer as an object: the expanded one when the event carried it, else one
 * retrieve. Null for a deleted customer or none.
 */
async function customerOf(sub: Stripe.Subscription): Promise<Stripe.Customer | null> {
	const ref = sub.customer;
	if (!ref) return null;
	if (typeof ref !== "string") return ref.deleted ? null : ref;
	const c = await getStripe().customers.retrieve(ref);
	return c.deleted ? null : c;
}

/**
 * Whether a payment method is on file for this subscription: its own default, or the customer's
 * invoice default. Decides which reminder a trial gets — "add a card or it ends" or "it continues".
 */
function hasPaymentMethodOnFile(sub: Stripe.Subscription, customer: Stripe.Customer | null): boolean {
	return Boolean(sub.default_payment_method) || Boolean(customer?.invoice_settings?.default_payment_method);
}

/**
 * The reminder sent before a trial ends (`customer.subscription.trial_will_end`, ~3 days out). A
 * card-less trial is told to add a payment method or return to Hobby; a trial with one on file is
 * told it continues.
 */
export async function sendTrialEndingEmail(sub: Stripe.Subscription): Promise<void> {
	if (!sub.trial_end) return;
	const customer = await customerOf(sub);
	const to = customer?.email ?? null;
	if (!to) return;
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: trialEndingSubject,
		react: TrialEndingEmail({
			orgName: await orgName(sub.metadata?.organization_id),
			planLabel: planLabelFromSub(sub),
			trialEndLabel: fmtDate(sub.trial_end),
			paymentMethodOnFile: hasPaymentMethodOnFile(sub, customer),
		}),
		devLog: `trial ending ${fmtDate(sub.trial_end)}`,
	});
}

/**
 * The notice sent when a card-less trial ran out with no payment method
 * (lib/billing/trial/end.ts `isCardlessTrialEnd`): the organization is on Hobby now, nothing was
 * deleted, and how to subscribe.
 */
export async function sendTrialEndedEmail(sub: Stripe.Subscription): Promise<void> {
	const to = await recipient(sub.customer);
	if (!to) return;
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: trialEndedSubject,
		react: TrialEndedEmail({
			orgName: await orgName(sub.metadata?.organization_id),
			planLabel: planLabelFromSub(sub),
			trialEndLabel: sub.trial_end ? fmtDate(sub.trial_end) : undefined,
		}),
		devLog: "trial ended",
	});
}

/** Which of a local trial's two emails: the reminder before its end, or the notice once it has ended. */
export type LocalTrialNotice = "ending" | "ended";

/**
 * One email about a LOCAL trial (lib/billing/trial/local.ts — the provider-less Pro grant a Paddle-era
 * org trials on), to the org owner. There is no Stripe subscription, so no Stripe event says the trial
 * is ending or has ended; the trial-notice sweep (lib/billing/trial/notices.ts) decides when, claims
 * the notice, and calls this. The copy is the Stripe trial's own, in its "subscribe" variant: a local
 * trial has nothing to add a card to — keeping Pro means buying it.
 *
 * Returns false when the org has no owner with an address (nothing was sent, and there is nobody to
 * retry for). Throws when the send itself failed, so the sweep gives the claim back.
 */
export async function sendLocalTrialNoticeEmail(args: {
	orgId: string;
	notice: LocalTrialNotice;
	trialEnd: Date;
}): Promise<boolean> {
	const to = await ownerEmail(args.orgId);
	if (!to) return false;
	const name = await orgName(args.orgId);
	const planLabel = planMeta("team").name;
	const trialEndLabel = formatDate(args.trialEnd);
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: args.notice === "ending" ? trialEndingSubject : trialEndedSubject,
		react:
			args.notice === "ending"
				? TrialEndingEmail({ orgName: name, planLabel, trialEndLabel, subscribeToKeep: true })
				: TrialEndedEmail({ orgName: name, planLabel, trialEndLabel, reason: "not_subscribed" }),
		devLog: `local trial ${args.notice} ${trialEndLabel} for ${name}`,
	});
	return true;
}

/** Confirmation that a subscription was canceled. */
export async function sendSubscriptionCanceledEmail(
	sub: Stripe.Subscription,
): Promise<void> {
	const to = await recipient(sub.customer);
	if (!to) return;
	const periodEnd = emailPlanItem(sub)?.current_period_end;
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: canceledSubject,
		react: SubscriptionCanceledEmail({
			orgName: await orgName(sub.metadata?.organization_id),
			planLabel: planLabelFromSub(sub),
			accessUntilLabel: periodEnd ? fmtDate(periodEnd) : undefined,
		}),
		devLog: "subscription canceled",
	});
}

/** One-time "welcome to your plan" email — rich onboarding into the tier. Sent once
 *  by the exactly-once claim in syncSubscriptionToBilling (trial or paid start). */
/**
 * The subscription-free core: welcome an org to a plan. Used by the Stripe path (via the adapter
 * below) AND by the off-Stripe operator path (Enterprise activated without a Stripe subscription).
 * Resolves the recipient from `to`, else the org owner's email. No-op if no recipient is found.
 */
export async function sendPlanWelcomeEmailForOrg(args: {
	orgId: string | undefined;
	plan: BillingPlan | null;
	isTrial: boolean;
	to?: string | null;
}): Promise<void> {
	const to = args.to ?? (await ownerEmail(args.orgId));
	if (!to) return;
	const meta = planMeta(args.plan ?? "team");
	const isTrial = args.isTrial;
	const features: FeatureRow[] = meta.checkoutFeatures?.length
		? meta.checkoutFeatures.map((f) => ({ title: f.title, detail: f.detail }))
		: meta.highlights.map((h) => ({ title: h }));
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: planWelcomeSubject({ planName: meta.name, isTrial }),
		react: WelcomeToPlanEmail({
			orgName: await orgName(args.orgId),
			planName: meta.name,
			tagline: meta.tagline,
			isTrial,
			features,
		}),
		devLog: `welcome to ${meta.name}${isTrial ? " (trial)" : ""}`,
	});
}

/** Stripe-path adapter: derive {orgId, plan, isTrial, to} from the subscription and delegate. */
export async function sendPlanWelcomeEmail(sub: Stripe.Subscription): Promise<void> {
	await sendPlanWelcomeEmailForOrg({
		orgId: sub.metadata?.organization_id,
		plan: planFromSubscription(sub, emailPlanItem(sub)?.price.id),
		isTrial: sub.status === "trialing",
		to: await recipient(sub.customer),
	});
}

/** Receipt for a one-time AI credit-pack purchase — invoiced, so the фактура is attached
 *  when one was issued (same as subscription receipts). */
export async function sendCreditPackReceiptEmail(
	invoice: Stripe.Invoice,
): Promise<void> {
	const credits = Number(invoice.metadata?.credits ?? 0);
	if (!(credits > 0)) return;
	const to = await recipient(invoice.customer, invoice.customer_email);
	if (!to) return;
	const amountLabel = money(invoice.amount_paid, invoice.currency);
	const doc = await receiptInvoice(invoice);
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: creditPackSubject({ credits }),
		react: CreditPackReceiptEmail({
			orgName: await orgName(invoice.metadata?.organization_id),
			credits,
			amountLabel,
			invoiceNumber: doc.number,
			invoiceAttached: doc.attachment !== null,
		}),
		attachments: doc.attachment ? [doc.attachment] : undefined,
		devLog: `credit pack ${credits} credits`,
	});
}

/**
 * The DURABLE CONFIRMATION for one order (CRD art. 8(7)).
 *
 * Sent from the ORDER, not from a Stripe object, and that is the point: the confirmation has to
 * carry facts Stripe never holds — which capacity the payer declared, which Terms version was in
 * force, and where the withdrawal period ends. Deriving it from an invoice would produce a receipt,
 * which is a different document with a different job.
 *
 * Best-effort like every other email on this path: a delivery failure must not roll back an order
 * that was genuinely placed and paid for. It IS logged, because an undelivered confirmation is a
 * duty unmet, not a cosmetic miss.
 */
export async function sendOrderConfirmationEmail(order: {
	organizationId: string;
	billingEmail: string | null;
	capacity: "consumer" | "organization";
	productLabel: string;
	totalMinorUnits: number;
	currency: string;
	renewsAutomatically: boolean;
	termsVersion: string;
	withdrawalPeriodEndsAt: Date | null;
	immediatePerformance: boolean;
}): Promise<void> {
	if (!order.billingEmail) return;
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to: order.billingEmail,
		subject: orderConfirmationSubject,
		react: OrderConfirmationEmail({
			orgName: await orgName(order.organizationId),
			productLabel: order.productLabel,
			totalLabel: money(order.totalMinorUnits, order.currency),
			capacity: order.capacity,
			renewsAutomatically: order.renewsAutomatically,
			termsVersion: order.termsVersion,
			withdrawalEndsLabel:
				order.capacity === "consumer" && order.withdrawalPeriodEndsAt
					? fmtDate(Math.floor(order.withdrawalPeriodEndsAt.getTime() / 1000))
					: undefined,
			immediatePerformance: order.immediatePerformance,
		}),
		devLog: `order confirmation ${order.productLabel} for ${order.organizationId}`,
	});
}

// ── Payment-hold notices (ADR 0002 Q3; sent by the payment-hold sweeper only) ──────────────────────

/** One payment-hold email's words. */
interface PaymentHoldNoticeCopy {
	subject: string;
	eyebrow: string;
	heading: string;
	body: string[];
}

/** The emails an `org_plan` hold is sent: never `released:adopted` (ADR 0004 D8). */
export type OrgPlanHoldNotice = Exclude<PaymentHoldNotifiedState, "released:adopted">;

/**
 * The copy of each `new_org` (create-a-team) payment-hold email: what was READ, never more (ADR 0002 I8,
 * §5.5).
 */
const NEW_ORG_HOLD_NOTICE_COPY: Record<PaymentHoldNotifiedState, PaymentHoldNoticeCopy> = {
	refund_pending: {
		subject: "Your refund from Alethia is on its way",
		eyebrow: "Refund issued",
		heading: "Your refund is on its way.",
		body: [
			"A payment for an earlier team setup went through after that checkout was cancelled, so nothing was set up for it. We have issued its refund, and it is on its way back to you.",
			"If you buy again before it arrives and that refund fails, you may see both charges until we have refunded it again.",
		],
	},
	"released:refunded": {
		subject: "Your Alethia refund is complete",
		eyebrow: "Refunded",
		heading: "Your payment was refunded in full.",
		body: [
			"An earlier payment for a team setup was refunded in full. It can take 5–10 business days to reach you, depending on your bank.",
		],
	},
	"released:adopted": {
		subject: "Your Alethia payment went through",
		eyebrow: "Payment confirmed",
		heading: "Your payment went through.",
		body: [
			"The payment for your earlier team setup went through, and the plan is yours. Open Create a team in Alethia to finish setting up your team.",
		],
	},
};

/**
 * The copy of each `org_plan` payment-hold email (ADR 0004 D8, O7): a plan bought for a team that already
 * exists, so it names no team setup and nothing to finish. Each email says what ADR 0002 §5.5's clause
 * for its state says (those clauses name no flow), with the payment named as an earlier plan checkout's.
 */
const ORG_PLAN_HOLD_NOTICE_COPY: Record<OrgPlanHoldNotice, PaymentHoldNoticeCopy> = {
	refund_pending: {
		subject: "Your refund from Alethia is on its way",
		eyebrow: "Refund issued",
		heading: "Your refund is on its way.",
		body: [
			"A payment for an earlier plan checkout went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you.",
			"If you buy again before it arrives and that refund fails, you may see both charges until we have refunded it again.",
		],
	},
	"released:refunded": {
		subject: "Your Alethia refund is complete",
		eyebrow: "Refunded",
		heading: "Your payment was refunded in full.",
		body: [
			"A payment for an earlier plan checkout was refunded in full. It can take 5–10 business days to reach you, depending on your bank.",
		],
	},
};

/** Renders and sends one payment-hold email. Throws when the send failed. */
async function sendHoldNoticeCopy(to: string, copy: PaymentHoldNoticeCopy, devLog: string): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: copy.subject,
		react: EmailLayout({
			preview: copy.heading,
			legal: BillingLegal(),
			children: [
				createElement(Text, { key: "eyebrow", className: "a-text-3", style: textStyle.eyebrow }, copy.eyebrow),
				createElement(Heading, { key: "heading", as: "h2", className: "a-text", style: textStyle.heading }, copy.heading),
				...copy.body.map((paragraph, i) =>
					createElement(Text, { key: `body-${i}`, className: "a-text-2", style: textStyle.body }, paragraph),
				),
			],
		}),
		devLog,
	});
}

/**
 * One `new_org` (create-a-team) payment-hold email (ADR 0002 Q3) to the payer's own address. Called by
 * the payment-hold sweeper after it claimed the notice (lib/billing/payment-holds/emails.ts), and nowhere
 * else. Carries no amount, card or invoice detail. Throws when the send failed, so the sweeper gives the
 * claim back.
 */
export async function sendPaymentHoldNoticeEmail(args: {
	to: string;
	notice: PaymentHoldNotifiedState;
}): Promise<void> {
	await sendHoldNoticeCopy(args.to, NEW_ORG_HOLD_NOTICE_COPY[args.notice], `payment hold notice ${args.notice}`);
}

/**
 * One `org_plan` payment-hold email (ADR 0004 D8) to the hold's Stripe customer's email. Called by the
 * payment-hold sweeper after it claimed the notice (lib/billing/payment-holds/emails.ts), and nowhere
 * else. Carries no amount, card or invoice detail. Throws when the send failed, so the sweeper gives the
 * claim back.
 */
export async function sendOrgPlanHoldNoticeEmail(args: { to: string; notice: OrgPlanHoldNotice }): Promise<void> {
	await sendHoldNoticeCopy(
		args.to,
		ORG_PLAN_HOLD_NOTICE_COPY[args.notice],
		`org-plan payment hold notice ${args.notice}`,
	);
}
