// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Branded billing emails, sent from the Stripe webhook. Alethia owns the customer
// email experience (receipt / dunning / trial / cancellation / credit pack) via SES
// rather than Stripe's default emails. Each fn maps the Stripe object(s) the webhook
// already holds onto a react-email template and sends through the suppression-aware
// guard on the general stream. The receipt carries Stripe's compliant invoice PDF as
// an attachment (Stripe stays the source of truth for the invoice document).

import type Stripe from "stripe";
import { planMeta } from "@repo/plan-catalog";
import { getEmailConfig } from "@repo/email/config";
import type { EmailAttachment } from "@repo/email/send";
import { and, asc, eq } from "drizzle-orm";
import { planForPriceId } from "@/lib/billing/config";
import { issueFactura } from "@/lib/billing/odoo-invoice";
import { getStripe } from "@/lib/billing/stripe";
import { planFromSubscription } from "@/lib/billing/sync";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import { member, organization, user } from "@/lib/db/schema";
import { CreditPackReceiptEmail, subject as creditPackSubject } from "@/emails/credit-pack-receipt";
import { PaymentFailedEmail, subject as paymentFailedSubject } from "@/emails/payment-failed";
import { ReceiptEmail, subject as receiptSubject } from "@/emails/receipt";
import {
	SubscriptionCanceledEmail,
	subject as canceledSubject,
} from "@/emails/subscription-canceled";
import { TrialEndingEmail, subject as trialEndingSubject } from "@/emails/trial-ending";
import {
	WelcomeToPlanEmail,
	subject as planWelcomeSubject,
} from "@/emails/welcome-to-plan";
import type { FeatureRow } from "@/emails/billing-shared";
import { sendGuardedEmail } from "./guard";

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Formats a Stripe smallest-unit amount as currency, e.g. (5800, "usd") → "$58.00". */
function money(amountMinor: number, currency: string): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(amountMinor / 100);
}

/** Formats a Stripe unix timestamp (seconds) as e.g. "Jul 3, 2026". */
function fmtDate(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/** "Jul 3 – Aug 3, 2026" from two unix timestamps; undefined if either is missing. */
function fmtPeriod(startSec?: number | null, endSec?: number | null): string | undefined {
	if (!startSec || !endSec) return undefined;
	return `${fmtDate(startSec)} – ${fmtDate(endSec)}`;
}

/** Display plan name ("Pro"/"Enterprise"/…) from a subscription's price. */
function planLabelFromSub(sub: Stripe.Subscription): string {
	const priceId = sub.items.data[0]?.price.id;
	const plan = priceId ? planForPriceId(priceId) : null;
	return planMeta(plan ?? "team").name;
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

/** The invoice PDF to attach to the receipt: the branded Odoo фактура when Odoo is
 *  configured, else Stripe's hosted PDF. Best-effort — null on any failure so a hiccup
 *  never blocks the receipt email. */
async function invoicePdfAttachment(
	invoice: Stripe.Invoice,
): Promise<EmailAttachment | null> {
	const factura = await issueFactura(invoice);
	if (factura) {
		const name = (factura.number ?? invoice.number ?? invoice.id ?? "invoice").replace(/\//g, "-");
		return { filename: `Invoice-${name}.pdf`, content: factura.pdf, contentType: "application/pdf" };
	}
	const url = invoice.invoice_pdf;
	if (!url) return null;
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		const content = new Uint8Array(await res.arrayBuffer());
		const name = (invoice.number ?? invoice.id ?? "invoice").replace(/\//g, "-");
		return { filename: `Invoice-${name}.pdf`, content, contentType: "application/pdf" };
	} catch {
		return null;
	}
}

// ── Senders (called by the Stripe webhook) ──────────────────────────────────

/** Receipt for a successful subscription payment, with the invoice PDF attached. */
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
	const props = {
		orgName: await orgName(orgId),
		planLabel,
		amountLabel,
		periodLabel: fmtPeriod(invoice.period_start, invoice.period_end),
		invoiceNumber: invoice.number ?? undefined,
	};
	const pdf = await invoicePdfAttachment(invoice);
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to,
		subject: receiptSubject({ amountLabel }),
		react: ReceiptEmail(props),
		attachments: pdf ? [pdf] : undefined,
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

/** Nudge sent ~3 days before a trial ends (trial_will_end). */
export async function sendTrialEndingEmail(sub: Stripe.Subscription): Promise<void> {
	const to = await recipient(sub.customer);
	if (!to || !sub.trial_end) return;
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
		}),
		devLog: `trial ending ${fmtDate(sub.trial_end)}`,
	});
}

/** Confirmation that a subscription was canceled. */
export async function sendSubscriptionCanceledEmail(
	sub: Stripe.Subscription,
): Promise<void> {
	const to = await recipient(sub.customer);
	if (!to) return;
	const periodEnd = sub.items.data[0]?.current_period_end;
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
		plan: planFromSubscription(sub, sub.items.data[0]?.price.id),
		isTrial: sub.status === "trialing",
		to: await recipient(sub.customer),
	});
}

/** Receipt for a one-time AI credit-pack purchase — now invoiced, so the compliant
 *  invoice PDF is attached (same as subscription receipts). */
export async function sendCreditPackReceiptEmail(
	invoice: Stripe.Invoice,
): Promise<void> {
	const credits = Number(invoice.metadata?.credits ?? 0);
	if (!(credits > 0)) return;
	const to = await recipient(invoice.customer, invoice.customer_email);
	if (!to) return;
	const amountLabel = money(invoice.amount_paid, invoice.currency);
	const pdf = await invoicePdfAttachment(invoice);
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
			invoiceNumber: invoice.number ?? undefined,
		}),
		attachments: pdf ? [pdf] : undefined,
		devLog: `credit pack ${credits} credits`,
	});
}
