"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing server actions (hosted): start a Stripe Checkout to upgrade the active org's
// plan, or open the Customer Portal to manage an existing subscription. Both are
// owner-gated (the manage_billing permission via the PDP) and operate on the actor's
// active org — never a client-supplied org id. Stripe then drives the
// organization_billing record through the webhook; entitlements follow.

import { eq } from "drizzle-orm";
import {
	deploymentMode,
	getStripeConfig,
	isStripeConfigured,
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
	/** A Stripe customer exists → the Customer Portal can be opened. */
	canManage: boolean;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;
	return {
		hosted: isStripeConfigured(),
		hasOrg,
		plan: billing?.plan ?? "community",
		status: billing?.status ?? "none",
		currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
		canManage: Boolean(billing?.stripeCustomerId),
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
async function ensureCustomer(orgId: string, userId: string): Promise<string> {
	const billing = await getOrgBilling(orgId);
	if (billing?.stripeCustomerId) return billing.stripeCustomerId;

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
		email: u?.email,
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
	const session = await getStripe().checkout.sessions.create({
		mode: "subscription",
		customer: customerId,
		line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
		subscription_data: { metadata: { organization_id: actor.orgId } },
		allow_promotion_codes: true,
		success_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=success`,
		cancel_url: `${cfg.appUrl}/dashboard/settings/billing?checkout=cancelled`,
	});
	if (!session.url) throw new Error("Stripe did not return a checkout URL.");
	return { url: session.url };
}

/**
 * Opens the Stripe Customer Portal for the active org (manage/cancel the subscription,
 * update payment method). Requires an existing Stripe customer. Returns the URL.
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
