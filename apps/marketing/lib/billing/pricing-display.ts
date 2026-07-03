// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live display prices for the public pricing page. The authoritative amount lives in
// Stripe (STRIPE_PRICE_TEAM) — we read it at render time so the marketing copy and the
// billed amount can never drift. Server-only. When Stripe isn't configured (dev /
// self-managed) or the lookup fails, we fall back to the static PLAN_CATALOG label so
// the public page always renders. Self-contained: the marketing app reads Stripe
// directly (STRIPE_SECRET_KEY / STRIPE_PRICE_TEAM) rather than the console billing config.

import { unstable_cache } from "next/cache";
import Stripe from "stripe";
import { formatSeatPrice, planMeta } from "@repo/plan-catalog";

let client: Stripe | null = null;

/** The lazily-built Stripe client. Returns null when STRIPE_SECRET_KEY is unset. */
function getStripe(): Stripe | null {
	const secretKey = process.env.STRIPE_SECRET_KEY;
	if (!secretKey) return null;
	if (!client) {
		client = new Stripe(secretKey, {
			appInfo: { name: "Alethia", url: "https://alethialabs.io" },
		});
	}
	return client;
}

/**
 * The Team per-seat price label, read live from Stripe and cached for an hour. Returns
 * the static catalog fallback when Stripe isn't configured or the retrieve fails — the
 * public pricing page must never throw on a price lookup.
 */
export const getTeamPriceLabel = unstable_cache(
	async (): Promise<string> => {
		const fallback = planMeta("team").priceLabel;
		const stripe = getStripe();
		const priceId = process.env.STRIPE_PRICE_TEAM;
		if (!stripe || !priceId) return fallback;
		try {
			const price = await stripe.prices.retrieve(priceId);
			if (typeof price.unit_amount !== "number") return fallback;
			return formatSeatPrice(
				price.unit_amount,
				price.currency,
				price.recurring?.interval,
			);
		} catch {
			return fallback;
		}
	},
	["pricing-team-price-label"],
	{ revalidate: 3600 },
);
