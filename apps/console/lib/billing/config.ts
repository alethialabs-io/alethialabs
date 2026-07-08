// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing/Stripe configuration. Entirely optional: when STRIPE_SECRET_KEY is unset
// (self-managed / community), checkout + webhooks are disabled and entitlements come
// from the signed license / community baseline instead. Hosted (alethialabs.io) sets
// the keys + per-plan price IDs and Stripe drives the organization_billing record.
// Server-only — never import from a client component.

import { z } from "zod";
import type { AiTier } from "@/lib/billing/ai-plan";
import type { BillingPlan } from "@/lib/db/schema/enums";

/** Paid plans that map to a Stripe price. `community` is free (no price). */
export type PaidPlan = Exclude<BillingPlan, "community">;

/** Paid AI tiers that map to a Stripe subscription price (`ai_free` is free). */
export type PaidAiTier = Exclude<AiTier, "ai_free">;

const schema = z.object({
	secretKey: z.string().min(1),
	webhookSecret: z.string().min(1),
	/** Stripe Price IDs per paid plan (test or live, matching the secret key).
	 * `team` (Pro) is the only self-serve Stripe price. `enterprise` is OPTIONAL —
	 * Enterprise is invoiced off-Stripe (sales-assisted) and granted via
	 * scripts/set-org-plan.mjs, so a Stripe price for it need not exist. */
	prices: z.object({
		team: z.string().min(1),
		enterprise: z.string().min(1).optional(),
	}),
	/**
	 * Optional GRADUATED metered Price IDs for runner job-minutes per plan — the
	 * free tier of each must mirror plan.ts `includedRunnerMinutes`, then $0.012/min.
	 * Unset → usage is surfaced but not billed through Stripe (metering opt-in).
	 */
	meterPrices: z
		.object({
			team: z.string().optional(),
			enterprise: z.string().optional(),
		})
		.optional(),
	/**
	 * Stripe Price IDs for the STANDALONE AI subscription tiers (separate product from the
	 * org plan). Both OPTIONAL — an unset tier simply can't be self-serve subscribed (the
	 * upgrade CTA errors clearly). `ai_free` needs no price (everyone's free allowance).
	 */
	aiPrices: z
		.object({
			plus: z.string().optional(),
			max: z.string().optional(),
		})
		.optional(),
	/** Absolute base URL for Checkout/Portal return links. */
	appUrl: z.string().url(),
});

/** Stripe meter event name for managed-runner job-minutes (see lib/billing/meter.ts). */
export const RUNNER_MINUTES_METER_EVENT = "alethia_runner_minutes";

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
 * The Stripe publishable key for the embedded Payment Element (client-side). Safe to
 * expose — it only identifies the account. Empty string when billing isn't configured.
 */
export function getPublishableKey(): string {
	return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
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
			enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
		},
		meterPrices: {
			team: process.env.STRIPE_PRICE_METER_TEAM,
			enterprise: process.env.STRIPE_PRICE_METER_ENTERPRISE,
		},
		aiPrices: {
			plus: process.env.STRIPE_PRICE_AI_PLUS,
			max: process.env.STRIPE_PRICE_AI_MAX,
		},
		appUrl: process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL,
	});
	if (!parsed.success) {
		throw new Error(`Invalid Stripe config: ${parsed.error.message}`);
	}
	cached = parsed.data;
	return cached;
}

/** The Stripe Price ID for a paid plan. Throws if that plan has no configured price
 *  (Enterprise is invoiced off-Stripe — grant it via scripts/set-org-plan.mjs). */
export function priceIdForPlan(plan: PaidPlan): string {
	const id = getStripeConfig().prices[plan];
	if (!id) {
		throw new Error(
			`No Stripe price configured for the ${plan} plan (set STRIPE_PRICE_${plan.toUpperCase()}).` +
				(plan === "enterprise"
					? " Enterprise is invoiced off-Stripe — use scripts/set-org-plan.mjs."
					: ""),
		);
	}
	return id;
}

/** The graduated metered Price ID for a plan's runner-minutes, if configured. */
export function meterPriceIdForPlan(plan: PaidPlan): string | undefined {
	return getStripeConfig().meterPrices?.[plan];
}

/** The paid plan a Stripe Price ID maps to, or null if it isn't one of ours. */
export function planForPriceId(priceId: string): PaidPlan | null {
	const { prices } = getStripeConfig();
	const entry = (Object.entries(prices) as [PaidPlan, string | undefined][]).find(
		([, id]) => id === priceId,
	);
	return entry ? entry[0] : null;
}

/** The `ai_plus`/`ai_max` key → its Stripe subscription Price ID. Throws if unset. */
export function aiPriceIdForTier(tier: PaidAiTier): string {
	const key = tier === "ai_plus" ? "plus" : "max";
	const id = getStripeConfig().aiPrices?.[key];
	if (!id) {
		throw new Error(
			`No Stripe price configured for the ${tier} AI tier (set STRIPE_PRICE_AI_${key.toUpperCase()}).`,
		);
	}
	return id;
}

/** The AI tier a Stripe Price ID maps to (`ai_plus`/`ai_max`), or null if it isn't one. */
export function aiTierForPriceId(priceId: string): PaidAiTier | null {
	const ai = getStripeConfig().aiPrices;
	if (!ai) return null;
	if (priceId === ai.plus) return "ai_plus";
	if (priceId === ai.max) return "ai_max";
	return null;
}
