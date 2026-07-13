// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe path for Enterprise onboarding: create a customer + a subscription billed by INVOICE
// (collection_method: send_invoice), at the CUSTOM negotiated amount, tagged with the org id +
// plan. Then it's hands-off — the console's Stripe webhook activates the plan on payment, mirrors
// the invoice, and sends the welcome email (the plan is resolved from metadata.plan, #420). Admin
// creating the objects (vs. staff typing them into the Stripe Dashboard) means metadata.organization_id
// is set programmatically from the selected org — a typo can't upgrade the wrong tenant.

import Stripe from "stripe";
import { env } from "next-runtime-env";

let cached: Stripe | null = null;

function stripe(): Stripe {
	if (cached) return cached;
	const key = env("STRIPE_SECRET_KEY");
	if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
	cached = new Stripe(key);
	return cached;
}

export interface EnterpriseSubInput {
	orgId: string;
	ownerEmail: string;
	amountCents: number;
	currency: string;
	interval: "month" | "year";
	daysUntilDue: number;
	seats?: number | null;
	/** Reuse an existing Stripe customer if the org already has one. */
	existingCustomerId?: string | null;
	createdBy: string;
}

/**
 * Creates the customer (or reuses one) + an invoiced Enterprise subscription. The line item uses an
 * inline `price_data` with the negotiated amount (NOT a catalog price — Enterprise has none). Returns
 * the Stripe ids so the operator can record them on the contract.
 */
export async function createEnterpriseInvoiceSubscription(
	input: EnterpriseSubInput,
): Promise<{ customerId: string; subscriptionId: string; invoiceUrl: string | null }> {
	const s = stripe();

	const customerId =
		input.existingCustomerId ??
		(
			await s.customers.create({
				email: input.ownerEmail,
				metadata: { organization_id: input.orgId, created_by: input.createdBy },
			})
		).id;

	// Ensure the org id is on the customer even when reusing one (the webhook trusts it).
	await s.customers.update(customerId, {
		metadata: { organization_id: input.orgId },
	});

	// Stripe subscription `price_data` requires a Product id (there is no inline product_data in that
	// shape). Enterprise line items reference STRIPE_ENTERPRISE_PRODUCT_ID.
	const productId = env("STRIPE_ENTERPRISE_PRODUCT_ID");
	if (!productId) {
		throw new Error(
			"STRIPE_ENTERPRISE_PRODUCT_ID is not configured — required for the Stripe path.",
		);
	}

	const sub = await s.subscriptions.create({
		customer: customerId,
		collection_method: "send_invoice",
		days_until_due: input.daysUntilDue,
		items: [
			{
				quantity: input.seats ?? 1,
				price_data: {
					currency: input.currency,
					unit_amount: input.amountCents,
					recurring: { interval: input.interval },
					product: productId,
				},
			},
		],
		metadata: {
			organization_id: input.orgId,
			plan: "enterprise",
			created_by: input.createdBy,
		},
	});

	const latestInvoice = sub.latest_invoice;
	const invoiceUrl =
		latestInvoice && typeof latestInvoice !== "string"
			? (latestInvoice.hosted_invoice_url ?? null)
			: null;

	return { customerId, subscriptionId: sub.id, invoiceUrl };
}
