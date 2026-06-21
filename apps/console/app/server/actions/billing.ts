"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing server actions (hosted): start a Stripe Checkout to upgrade the active org's
// plan, or open the Customer Portal to manage an existing subscription. Both are
// owner-gated (the manage_billing permission via the PDP) and operate on the actor's
// active org — never a client-supplied org id. Stripe then drives the
// organization_billing record through the webhook; entitlements follow.

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
	deploymentMode,
	getStripeConfig,
	isStripeConfigured,
	isStripeTaxEnabled,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { organization, user } from "@/lib/db/schema";

/** Read-only billing state for the active org, for the /settings/billing page. */
export interface BillingSummary {
	/** Stripe is wired on this deployment (hosted). Self-managed → no upgrade UI. */
	hosted: boolean;
	/** The actor has a real workspace (org), not just their personal scope. */
	hasOrg: boolean;
	plan: BillingPlan;
	status: BillingStatus;
	/** ISO timestamp the current paid period ends, if subscribed. */
	currentPeriodEnd: string | null;
	/** A Stripe customer exists → cards/invoices are available. */
	canManage: boolean;
	/** The subscription is set to cancel at period end (show "resume"). */
	cancelAtPeriodEnd: boolean;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;

	let cancelAtPeriodEnd = false;
	if (billing?.stripeSubscriptionId && isStripeConfigured()) {
		try {
			const sub = await getStripe().subscriptions.retrieve(
				billing.stripeSubscriptionId,
			);
			cancelAtPeriodEnd = sub.cancel_at_period_end;
		} catch {
			// Subscription unreadable (deleted upstream) — treat as not pending-cancel.
		}
	}

	return {
		hosted: isStripeConfigured(),
		hasOrg,
		plan: billing?.plan ?? "community",
		status: billing?.status ?? "none",
		currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
		canManage: Boolean(billing?.stripeCustomerId),
		cancelAtPeriodEnd,
	};
}

/** Guards that billing is actually wired (hosted control plane) before any Stripe call. */
function requireHostedBilling(): void {
	if (!isStripeConfigured()) {
		throw new Error(
			`Billing is not enabled on this deployment (${deploymentMode()} mode).`,
		);
	}
}

/**
 * Returns the org's Stripe customer id, creating + persisting one on first use. The
 * customer carries organization_id metadata so webhook events resolve back to the org.
 */
async function ensureCustomer(
	orgId: string,
	userId: string,
	billingEmail?: string,
): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (billing?.stripeCustomerId) {
		if (billingEmail) {
			await getStripe().customers.update(billing.stripeCustomerId, {
				email: billingEmail,
			});
		}
		return billing.stripeCustomerId;
	}

	const db = getServiceDb();
	const [u] = await db
		.select({ email: user.email, name: user.name })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const [org] = await db
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);

	const customer = await getStripe().customers.create({
		email: billingEmail || u?.email,
		name: org?.name,
		metadata: { organization_id: orgId, created_by: userId },
	});

	// Persist the customer id without disturbing any existing plan/status.
	await upsertOrgBilling({
		organizationId: orgId,
		plan: billing?.plan ?? "community",
		status: billing?.status ?? "none",
		stripeCustomerId: customer.id,
		stripeSubscriptionId: billing?.stripeSubscriptionId ?? null,
		seats: billing?.seats ?? null,
		currentPeriodEnd: billing?.currentPeriodEnd ?? null,
	});
	return customer.id;
}

/**
 * Starts a Stripe Checkout to subscribe the active org to a paid plan. Requires a real
 * org (not the personal scope — create a workspace first). Returns the redirect URL.
 */
export async function createCheckoutSession(
	plan: PaidPlan,
): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create a workspace before subscribing to a plan.");
	}

	const cfg = getStripeConfig();
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	// Stripe Tax: compute VAT/sales tax + collect the customer's Tax/VAT id (EU B2B
	// reverse-charge). Gated until the account's Tax settings are configured.
	const tax: Partial<Stripe.Checkout.SessionCreateParams> = isStripeTaxEnabled()
		? {
				automatic_tax: { enabled: true },
				tax_id_collection: { enabled: true },
				customer_update: { name: "auto", address: "auto" },
			}
		: {};
	const session = await getStripe().checkout.sessions.create({
		mode: "subscription",
		customer: customerId,
		line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
		subscription_data: { metadata: { organization_id: actor.orgId } },
		allow_promotion_codes: true,
		...tax,
		success_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=success`,
		cancel_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=cancelled`,
	});
	if (!session.url) throw new Error("Stripe did not return a checkout URL.");
	return { url: session.url };
}

/** A subscription awaiting its first payment, for the embedded Payment Element. */
export interface SubscriptionIntent {
	clientSecret: string;
	subscriptionId: string;
}

/**
 * Creates an incomplete subscription for the active org and returns the client secret
 * of its first invoice's payment — the embedded (in-app) alternative to hosted
 * Checkout. The <PaymentForm> confirms it (card + 3-D Secure inline); the webhook then
 * activates the org. Owner-gated; org-scoped; refuses if a live subscription already
 * exists (use changeSubscriptionPlan instead).
 */
export async function createSubscriptionIntent(
	plan: PaidPlan,
	opts?: { seats?: number; billingEmail?: string },
): Promise<SubscriptionIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create a workspace before subscribing to a plan.");
	}
	const existing = await getOrgBilling(actor.orgId);
	if (
		existing?.stripeSubscriptionId &&
		(existing.status === "active" || existing.status === "trialing")
	) {
		throw new Error(
			"This organization already has an active subscription — change the plan instead.",
		);
	}

	const customerId = await ensureCustomer(
		actor.orgId,
		actor.userId,
		opts?.billingEmail,
	);
	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	// Only the Team price is per-seat (per-unit) — bill the requested seat count.
	// Business/Enterprise are flat, so their quantity stays 1.
	const quantity = plan === "team" ? Math.max(1, opts?.seats ?? 1) : 1;
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: [{ price: priceIdForPlan(plan), quantity }],
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		metadata: { organization_id: actor.orgId },
		...taxParam,
	});

	const invoice = sub.latest_invoice;
	if (!invoice || typeof invoice === "string") {
		throw new Error("Stripe did not return an invoice for the subscription.");
	}
	const clientSecret = invoice.confirmation_secret?.client_secret;
	if (!clientSecret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret, subscriptionId: sub.id };
}

// ── Payment methods (embedded card management) ──────────────────────────────

/** A saved card for the active org's billing UI. */
export interface PaymentMethodInfo {
	id: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
	isDefault: boolean;
}

/** Creates a SetupIntent to add/save a card via the embedded Payment Element. */
export async function createSetupIntent(): Promise<{ clientSecret: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create a workspace before adding a card.");
	}
	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const si = await getStripe().setupIntents.create({
		customer: customerId,
		usage: "off_session",
		payment_method_types: ["card"],
	});
	if (!si.client_secret) {
		throw new Error("Stripe did not return a setup client secret.");
	}
	return { clientSecret: si.client_secret };
}

/** Lists the active org's saved cards (with which one is the default). */
export async function listPaymentMethods(): Promise<PaymentMethodInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	const defaultRef =
		"deleted" in customer
			? null
			: customer.invoice_settings.default_payment_method;
	const defaultId =
		typeof defaultRef === "string" ? defaultRef : (defaultRef?.id ?? null);

	const pms = await stripe.paymentMethods.list({
		customer: billing.stripeCustomerId,
		type: "card",
	});
	return pms.data.map((pm) => ({
		id: pm.id,
		brand: pm.card?.brand ?? "card",
		last4: pm.card?.last4 ?? "••••",
		expMonth: pm.card?.exp_month ?? 0,
		expYear: pm.card?.exp_year ?? 0,
		isDefault: pm.id === defaultId,
	}));
}

/** Makes a saved card the default for invoices + the active subscription. */
export async function setDefaultPaymentMethod(
	pmId: string,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	await stripe.customers.update(billing.stripeCustomerId, {
		invoice_settings: { default_payment_method: pmId },
	});
	if (billing.stripeSubscriptionId) {
		await stripe.subscriptions.update(billing.stripeSubscriptionId, {
			default_payment_method: pmId,
		});
	}
	return { ok: true };
}

/** Removes a saved card (after verifying it belongs to the active org's customer). */
export async function detachPaymentMethod(pmId: string): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const pm = await stripe.paymentMethods.retrieve(pmId);
	const ownerId =
		typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
	if (ownerId !== billing.stripeCustomerId) {
		throw new Error("Payment method not found.");
	}
	await stripe.paymentMethods.detach(pmId);
	return { ok: true };
}

// ── Subscription management (embedded — replaces the Customer Portal) ────────

/** Loads the active org's subscription, or throws if there isn't one. */
async function requireSubscriptionId(orgId: string): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (!billing?.stripeSubscriptionId) {
		throw new Error("No active subscription.");
	}
	return billing.stripeSubscriptionId;
}

/** Schedules cancellation at the end of the current paid period. */
export async function cancelSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
	return { ok: true };
}

/** Un-schedules a pending cancellation. */
export async function resumeSubscription(): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	await getStripe().subscriptions.update(subId, { cancel_at_period_end: false });
	return { ok: true };
}

/** Switches the active subscription to a different paid plan, prorated. */
export async function changeSubscriptionPlan(
	plan: PaidPlan,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const subId = await requireSubscriptionId(actor.orgId);
	const stripe = getStripe();
	const sub = await stripe.subscriptions.retrieve(subId);
	const itemId = sub.items.data[0]?.id;
	if (!itemId) throw new Error("Subscription has no line item.");
	await stripe.subscriptions.update(subId, {
		items: [{ id: itemId, price: priceIdForPlan(plan) }],
		proration_behavior: "create_prorations",
	});
	return { ok: true };
}

// ── Invoices + billing details / VAT ────────────────────────────────────────

/** An invoice row for the billing UI. */
export interface InvoiceInfo {
	id: string;
	number: string | null;
	/** Total in the smallest currency unit (e.g. cents). */
	total: number;
	currency: string;
	status: string;
	created: string;
	invoicePdf: string | null;
	hostedInvoiceUrl: string | null;
}

/** Lists the active org's recent invoices (with PDF links). */
export async function listInvoices(): Promise<InvoiceInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const invoices = await getStripe().invoices.list({
		customer: billing.stripeCustomerId,
		limit: 24,
	});
	return invoices.data.map((inv) => ({
		id: inv.id ?? "",
		number: inv.number ?? null,
		total: inv.total,
		currency: inv.currency,
		status: inv.status ?? "draft",
		created: new Date(inv.created * 1000).toISOString(),
		invoicePdf: inv.invoice_pdf ?? null,
		hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
	}));
}

/** The active org's billing contact + address + VAT id (for Stripe Tax). */
export interface BillingDetails {
	name: string;
	email: string;
	line1: string;
	line2: string;
	city: string;
	state: string;
	postalCode: string;
	country: string;
	taxId: string | null;
}

/** Reads the active org's billing details, or null if there's no customer yet. */
export async function getBillingDetails(): Promise<BillingDetails | null> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return null;

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	if ("deleted" in customer) return null;
	const addr = customer.address;
	const taxIds = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 1,
	});
	return {
		name: customer.name ?? "",
		email: customer.email ?? "",
		line1: addr?.line1 ?? "",
		line2: addr?.line2 ?? "",
		city: addr?.city ?? "",
		state: addr?.state ?? "",
		postalCode: addr?.postal_code ?? "",
		country: addr?.country ?? "",
		taxId: taxIds.data[0]?.value ?? null,
	};
}

/** Billing contact + address (required for Stripe Tax to compute VAT). */
export interface BillingAddressInput {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	state?: string;
	postalCode: string;
	/** ISO 3166-1 alpha-2 (e.g. "DE", "EE"). */
	country: string;
}

/** Saves the active org's billing name + address on its Stripe customer. */
export async function updateBillingAddress(
	input: BillingAddressInput,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	await getStripe().customers.update(billing.stripeCustomerId, {
		name: input.name,
		address: {
			line1: input.line1,
			line2: input.line2,
			city: input.city,
			state: input.state,
			postal_code: input.postalCode,
			country: input.country,
		},
	});
	return { ok: true };
}

/** Sets (or clears) the active org's EU VAT id — one per customer for our UI. */
export async function saveTaxId(value: string): Promise<{ ok: true }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) throw new Error("No billing account yet.");

	const stripe = getStripe();
	const existing = await stripe.customers.listTaxIds(billing.stripeCustomerId, {
		limit: 5,
	});
	for (const t of existing.data) {
		await stripe.customers.deleteTaxId(billing.stripeCustomerId, t.id);
	}
	const trimmed = value.trim();
	if (trimmed) {
		await stripe.customers.createTaxId(billing.stripeCustomerId, {
			type: "eu_vat",
			value: trimmed,
		});
	}
	return { ok: true };
}

/**
 * Opens the Stripe Customer Portal for the active org (manage/cancel the subscription,
 * update payment method). Requires an existing Stripe customer. Returns the URL.
 * Retained as a fallback alongside the embedded flow.
 */
export async function createBillingPortalSession(): Promise<{ url: string }> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();

	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) {
		throw new Error("No billing account yet — subscribe to a plan first.");
	}
	const session = await getStripe().billingPortal.sessions.create({
		customer: billing.stripeCustomerId,
		return_url: `${getStripeConfig().appUrl}/dashboard/settings/billing`,
	});
	return { url: session.url };
}
