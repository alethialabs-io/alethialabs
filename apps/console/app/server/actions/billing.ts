"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing server actions (hosted): start a Stripe Checkout to upgrade the active org's
// plan, or open the Customer Portal to manage an existing subscription. Both are
// owner-gated (the manage_billing permission via the PDP) and operate on the actor's
// active org — never a client-supplied org id. Stripe then drives the
// organization_billing record through the webhook; entitlements follow.

import { count, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { RESERVED_SLUGS } from "@/lib/routing";
import {
	deploymentMode,
	getStripeConfig,
	isStripeConfigured,
	isStripeTaxEnabled,
	meterPriceIdForPlan,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { creditPack } from "@/lib/billing/ai-credits";
import { planMeta } from "@repo/plan-catalog";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { computeUsage, type UsageSummary } from "@/lib/billing/usage";
import { queryJobMinutesByOrg } from "@/lib/queries/runner-usage";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { member, organization, organizationBilling, user } from "@/lib/db/schema";

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
	/** Subscribed seat count (Team's per-seat quantity), or null for flat plans. */
	seats: number | null;
	/** Current members in the org — the "used" side of the seats meter. */
	memberCount: number;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;

	// Member count seeds the seats meter; only meaningful in a real org.
	let memberCount = 0;
	if (hasOrg) {
		const [c] = await getServiceDb()
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, actor.orgId));
		memberCount = c?.n ?? 0;
	}

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
		seats: billing?.seats ?? null,
		memberCount,
	};
}

/** Managed-runner usage for the active org's current period (read-only; any member). */
export interface UsageReport extends UsageSummary {
	periodStart: string;
	periodEnd: string;
	plan: BillingPlan;
	/** "Pause at the included allowance instead of billing overage" is enabled. */
	hardCap: boolean;
}

/**
 * Job-minutes consumed on managed runners this period vs the plan's included
 * allowance, with the overage estimate. The customer-facing usage meter
 * (lib/billing/usage). Self-hosted runners never count.
 */
export async function getOrgUsage(): Promise<UsageReport> {
	const actor = await currentActor();
	const billing = await getOrgBilling(actor.orgId).catch(() => null);
	const plan = billing?.plan ?? "community";
	const status = billing?.status ?? "none";
	const included =
		resolvePlanEntitlements(plan, status).quotas.includedRunnerMinutes;

	const now = new Date();
	const from =
		billing?.currentPeriodStart ??
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

	const rows = await queryJobMinutesByOrg(getServiceDb(), {
		from,
		to: now,
		orgId: actor.orgId,
	});
	const used = rows[0]?.job_minutes ?? 0;

	return {
		...computeUsage(used, included),
		periodStart: from.toISOString(),
		periodEnd: (billing?.currentPeriodEnd ?? now).toISOString(),
		plan,
		hardCap: billing?.usageHardCap ?? false,
	};
}

/**
 * Toggle the active org's "pause at included instead of overage" policy
 * (owner-gated). A pure usage-policy flag — independent of Stripe.
 */
export async function setUsageHardCap(enabled: boolean): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	await getServiceDb()
		.update(organizationBilling)
		.set({ usageHardCap: enabled, updatedAt: new Date() })
		.where(eq(organizationBilling.organizationId, actor.orgId));
}

/** Guards that billing is actually wired (hosted control plane) before any Stripe call. */
function requireHostedBilling(): void {
	if (!isStripeConfigured()) {
		throw new Error(
			`Billing is not enabled on this deployment (${deploymentMode()} mode).`,
		);
	}
}

/** New-subscription items: the flat plan item + (if configured) the graduated metered
 *  runner-minutes item. Metered items carry no quantity. */
function planCreateItems(
	plan: PaidPlan,
	quantity: number,
): Stripe.SubscriptionCreateParams.Item[] {
	const items: Stripe.SubscriptionCreateParams.Item[] = [
		{ price: priceIdForPlan(plan), quantity },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** Checkout line items: flat plan + (if configured) metered runner-minutes. */
function planCheckoutLineItems(
	plan: PaidPlan,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
	const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
		{ price: priceIdForPlan(plan), quantity: 1 },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter) items.push({ price: meter });
	return items;
}

/** All configured metered price IDs — to recognize an existing metered sub item. */
function configuredMeterPriceIds(): Set<string> {
	const ids = new Set<string>();
	for (const p of ["team", "enterprise"] as const) {
		const id = meterPriceIdForPlan(p);
		if (id) ids.add(id);
	}
	return ids;
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
		line_items: planCheckoutLineItems(plan),
		subscription_data: {
			metadata: { organization_id: actor.orgId },
			// Team gets a one-month free trial (the public "Start free trial" CTA).
			// Flat tiers subscribe immediately.
			...(plan === "team" ? { trial_period_days: 30 } : {}),
		},
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
	// Enterprise is flat, so its quantity stays 1.
	const quantity = plan === "team" ? Math.max(1, opts?.seats ?? 1) : 1;
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems(plan, quantity),
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

/**
 * Whether an org slug is still free. Used by the create-org sheet to validate the slug
 * BEFORE taking payment (the org itself isn't created until the charge succeeds), so a
 * collision surfaces inline instead of after the customer has paid. Authenticated only.
 */
export async function isOrgSlugAvailable(slug: string): Promise<boolean> {
	await currentActor();
	const normalized = slug.trim().toLowerCase();
	if (!normalized) return false;
	// Reserved slugs shadow console routes or are owned by the marketing zone /
	// sibling apps (see RESERVED_SLUGS) — never available even if unused in the DB.
	if (RESERVED_SLUGS.has(normalized)) return false;
	const [row] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, normalized))
		.limit(1);
	return !row;
}

/** A new-org subscription intent: the awaiting-payment sub plus the bare customer it
 *  hangs off, both carried back to the client so the org can be linked post-payment. */
export interface NewOrgSubscriptionIntent extends SubscriptionIntent {
	customerId: string;
}

/**
 * Creates an incomplete subscription for an org that doesn't exist yet — the deferred
 * create-org flow: take payment first, then create + link the org (linkSubscriptionToNewOrg).
 * The customer/sub carry `created_by` (not `organization_id`) so they can't be claimed by
 * another user, and the webhook ignores them until the link step stamps the org id.
 *
 * Idempotent across retries: pass the prior `customerId` to reuse it and `priorSubscriptionId`
 * to cancel the previous incomplete sub (e.g. after "← Back" or a seat change), so a Stripe
 * customer is never duplicated and incomplete subscriptions don't pile up.
 */
export async function createNewOrgSubscriptionIntent(
	plan: PaidPlan,
	opts: {
		seats?: number;
		orgName: string;
		priorSubscriptionId?: string;
		customerId?: string;
	},
): Promise<NewOrgSubscriptionIntent> {
	const actor = await currentActor();
	requireHostedBilling();

	// Reuse the customer from a prior attempt only if this user owns it; otherwise mint
	// a fresh bare customer (no organization_id until the org exists and is linked).
	let customerId: string | null = null;
	if (opts.customerId) {
		const existing = await getStripe().customers.retrieve(opts.customerId);
		if (
			!existing.deleted &&
			existing.metadata?.created_by === actor.userId
		) {
			customerId = existing.id;
		}
	}
	if (!customerId) {
		const [u] = await getServiceDb()
			.select({ email: user.email, name: user.name })
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		const customer = await getStripe().customers.create({
			email: u?.email,
			name: opts.orgName,
			metadata: { created_by: actor.userId },
		});
		customerId = customer.id;
	}

	// Cancel the previous incomplete sub from this attempt so it doesn't leak.
	if (opts.priorSubscriptionId) {
		try {
			await getStripe().subscriptions.cancel(opts.priorSubscriptionId);
		} catch {
			// Already gone / expired — nothing to clean up.
		}
	}

	const taxParam: Partial<Stripe.SubscriptionCreateParams> = isStripeTaxEnabled()
		? { automatic_tax: { enabled: true } }
		: {};
	const quantity = plan === "team" ? Math.max(1, opts.seats ?? 1) : 1;
	const sub = await getStripe().subscriptions.create({
		customer: customerId,
		items: planCreateItems(plan, quantity),
		payment_behavior: "default_incomplete",
		payment_settings: { save_default_payment_method: "on_subscription" },
		expand: ["latest_invoice.confirmation_secret"],
		metadata: { created_by: actor.userId },
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
	return { clientSecret, subscriptionId: sub.id, customerId };
}

/**
 * Links a just-paid subscription (from createNewOrgSubscriptionIntent) to the org the
 * client created after payment, then writes the billing record synchronously so the
 * org's entitlements are live immediately (no webhook race). Owner-gated on the new org;
 * verifies the sub/customer were minted by this actor and aren't already linked.
 */
export async function linkSubscriptionToNewOrg(input: {
	orgId: string;
	subscriptionId: string;
	customerId: string;
}): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId !== input.orgId) {
		throw new Error("The new organization must be the active organization.");
	}

	const sub = await getStripe().subscriptions.retrieve(input.subscriptionId);
	const subCustomerId =
		typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	if (subCustomerId !== input.customerId) {
		throw new Error("Subscription does not match the expected customer.");
	}
	if (sub.metadata?.organization_id) {
		throw new Error("Subscription is already linked to an organization.");
	}
	const customer = await getStripe().customers.retrieve(input.customerId);
	if (customer.deleted || customer.metadata?.created_by !== actor.userId) {
		throw new Error("Not allowed to link this subscription.");
	}

	const [org] = await getServiceDb()
		.select({ name: organization.name })
		.from(organization)
		.where(eq(organization.id, input.orgId))
		.limit(1);

	await getStripe().customers.update(input.customerId, {
		name: org?.name,
		metadata: { created_by: actor.userId, organization_id: input.orgId },
	});
	const linked = await getStripe().subscriptions.update(input.subscriptionId, {
		metadata: { created_by: actor.userId, organization_id: input.orgId },
	});

	// Deterministic activation — don't wait for the (already-fired) webhook.
	await syncSubscriptionToBilling(linked);
}

/** A one-time credit-pack payment awaiting confirmation, for the embedded Payment Element. */
export interface CreditPackIntent {
	clientSecret: string;
	paymentIntentId: string;
}

/**
 * Creates a one-time PaymentIntent for an AI credit pack (a top-up beyond the plan's
 * included usage). The embedded <PaymentForm mode="payment"> confirms it inline; the
 * webhook's `payment_intent.succeeded` branch grants the credits (idempotent on the
 * intent id). Owner-gated; org-scoped; hosted billing only.
 */
export async function createCreditPackIntent(
	packId: string,
): Promise<CreditPackIntent> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) {
		throw new Error("Create a workspace before buying AI credits.");
	}
	const pack = creditPack(packId);
	if (!pack) throw new Error("Unknown credit pack.");

	const customerId = await ensureCustomer(actor.orgId, actor.userId);
	const intent = await getStripe().paymentIntents.create({
		customer: customerId,
		amount: pack.amountCents,
		currency: "usd",
		automatic_payment_methods: { enabled: true },
		metadata: {
			organization_id: actor.orgId,
			user_id: actor.userId,
			product_type: "ai_credits",
			credits: String(pack.credits),
		},
	});
	if (!intent.client_secret) {
		throw new Error("Stripe did not return a payment client secret.");
	}
	return { clientSecret: intent.client_secret, paymentIntentId: intent.id };
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

	// Distinguish the flat plan item from the metered runner-minutes item so a plan
	// change swaps both (their graduated included tiers differ per plan).
	const meterIds = configuredMeterPriceIds();
	let flatItemId: string | undefined;
	let meterItemId: string | undefined;
	for (const it of sub.items.data) {
		if (meterIds.has(it.price.id)) meterItemId = it.id;
		else flatItemId = it.id;
	}
	if (!flatItemId) throw new Error("Subscription has no plan line item.");

	const items: Stripe.SubscriptionUpdateParams.Item[] = [
		{ id: flatItemId, price: priceIdForPlan(plan) },
	];
	const meter = meterPriceIdForPlan(plan);
	if (meter && meterItemId) items.push({ id: meterItemId, price: meter });
	else if (meter) items.push({ price: meter });
	else if (meterItemId) items.push({ id: meterItemId, deleted: true });

	await stripe.subscriptions.update(subId, {
		items,
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

// ── Transactions (Stripe charges) ───────────────────────────────────────────

/** A charge row for the transaction-history table. */
export interface TransactionInfo {
	id: string;
	/** What the charge was for (Stripe description, or a sensible fallback). */
	description: string;
	/** Normalized outcome driving the status badge. */
	status: "paid" | "pending" | "failed" | "refunded";
	/** Smallest-unit amount; negative for refunds. */
	amount: number;
	currency: string;
	created: string;
	/** "Visa ···· 4242", or null when the method isn't a card. */
	method: string | null;
}

/** Maps a Stripe charge to our normalized transaction shape. */
function toTransaction(charge: Stripe.Charge): TransactionInfo {
	const card = charge.payment_method_details?.card;
	const method = card
		? `${card.brand ?? "card"} ···· ${card.last4 ?? "••••"}`
		: null;
	const refunded = charge.refunded || charge.amount_refunded > 0;
	const status: TransactionInfo["status"] = refunded
		? "refunded"
		: charge.status === "succeeded"
			? "paid"
			: charge.status === "failed"
				? "failed"
				: "pending";
	return {
		id: charge.id,
		description: charge.description ?? "Subscription payment",
		status,
		amount: refunded ? -charge.amount_refunded : charge.amount,
		currency: charge.currency,
		created: new Date(charge.created * 1000).toISOString(),
		method,
	};
}

/** Lists the active org's recent charges (paid / failed / refunded) for the ledger. */
export async function listTransactions(): Promise<TransactionInfo[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const charges = await getStripe().charges.list({
		customer: billing.stripeCustomerId,
		limit: 24,
	});
	return charges.data.map(toTransaction);
}

// ── Plan history (minimal — derived, no event log yet) ──────────────────────

/** A plan-history timeline entry. */
export interface PlanHistoryEntry {
	when: string;
	title: string;
	detail: string;
	/** The current (most recent) entry — rendered as the active node. */
	current: boolean;
}

/**
 * A best-effort plan-history timeline for the active org. We don't keep a billing
 * event log yet, so this is derived honestly from what we know: when the org was
 * created, and the plan it's on now. (A real ledger is future work.)
 */
export async function getPlanHistory(): Promise<PlanHistoryEntry[]> {
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	if (actor.orgId === actor.userId) return [];

	const [org] = await getServiceDb()
		.select({ name: organization.name, createdAt: organization.createdAt })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	if (!org) return [];

	const billing = await getOrgBilling(actor.orgId);
	const entries: PlanHistoryEntry[] = [
		{
			when: org.createdAt.toISOString(),
			title: "Organization created",
			detail: `${org.name} started on the Free plan.`,
			current: false,
		},
	];
	const isLive =
		billing && (billing.status === "active" || billing.status === "trialing");
	if (isLive && billing.plan !== "community") {
		const meta = planMeta(billing.plan);
		const since =
			billing.currentPeriodEnd?.toISOString() ?? new Date().toISOString();
		entries.push({
			when: since,
			title: `On the ${meta.name} plan`,
			detail: meta.tagline,
			current: true,
		});
	} else {
		// No live paid plan → the "created" entry is the current state.
		entries[0].current = true;
	}
	return entries.reverse(); // newest first
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
