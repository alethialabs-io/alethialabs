// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing/Stripe configuration. Entirely optional: when STRIPE_SECRET_KEY is unset
// (self-managed / community), checkout + webhooks are disabled and entitlements come
// from the signed license / community baseline instead. Hosted (alethialabs.io) sets
// the keys + per-plan price IDs and Stripe drives the organization_billing record.
// Server-only — never import from a client component.

import { z } from "zod";
import type { BillingPlan } from "@/lib/db/schema/enums";

/** Paid plans that map to a Stripe price. `community` is free (no price). */
export type PaidPlan = Exclude<BillingPlan, "community">;

const schema = z.object({
	secretKey: z.string().min(1),
	webhookSecret: z.string().min(1),
	/** Stripe Price IDs per paid plan (test or live, matching the secret key). */
	prices: z.object({
		team: z.string().min(1),
		business: z.string().min(1),
		enterprise: z.string().min(1),
	}),
	/** Absolute base URL for Checkout/Portal return links. */
	appUrl: z.string().url(),
});

export type StripeConfig = z.infer<typeof schema>;

/** Deployment mode: hosted = Stripe-driven billing; self-managed = license/community. */
export function deploymentMode(): "hosted" | "self-managed" {
	return process.env.ALETHIA_DEPLOYMENT_MODE === "hosted"
		? "hosted"
		: "self-managed";
}

/** Whether Stripe billing is wired (hosted control plane). */
export function isStripeConfigured(): boolean {
	return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Whether to compute tax + collect VAT/Tax IDs at checkout (Stripe Tax). OFF by
 * default: `automatic_tax` requires the account's Tax origin address + registrations
 * to be configured first, or Checkout errors. Flip `STRIPE_TAX_ENABLED=true` once
 * Stripe Tax is set up in the dashboard.
 */
export function isStripeTaxEnabled(): boolean {
	return process.env.STRIPE_TAX_ENABLED === "true";
}

let cached: StripeConfig | null = null;

/** The validated Stripe config (cached). Throws if billing is used but misconfigured. */
export function getStripeConfig(): StripeConfig {
	if (cached) return cached;
	const parsed = schema.safeParse({
		secretKey: process.env.STRIPE_SECRET_KEY,
		webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
		prices: {
			team: process.env.STRIPE_PRICE_TEAM,
			business: process.env.STRIPE_PRICE_BUSINESS,
			enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
		},
		appUrl: process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL,
	});
	if (!parsed.success) {
		throw new Error(`Invalid Stripe config: ${parsed.error.message}`);
	}
	cached = parsed.data;
	return cached;
}

/** The Stripe Price ID for a paid plan. */
export function priceIdForPlan(plan: PaidPlan): string {
	return getStripeConfig().prices[plan];
}

/** The paid plan a Stripe Price ID maps to, or null if it isn't one of ours. */
export function planForPriceId(priceId: string): PaidPlan | null {
	const { prices } = getStripeConfig();
	const entry = (Object.entries(prices) as [PaidPlan, string][]).find(
		([, id]) => id === priceId,
	);
	return entry ? entry[0] : null;
}
