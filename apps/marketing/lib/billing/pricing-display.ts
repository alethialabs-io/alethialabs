// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live display prices for the public pricing page. The authoritative amount lives in
// Stripe (STRIPE_PRICE_TEAM) — we read it at render time so the marketing copy and the
// billed amount can never drift. Server-only. When Stripe isn't configured (dev /
// self-managed) or the lookup fails, we fall back to the static PLAN_CATALOG label so
// the public page always renders. Self-contained: the marketing app reads Stripe
// directly (STRIPE_SECRET_KEY / STRIPE_PRICE_TEAM) rather than the console billing config.

import { unstable_cache } from "next/cache";
import Stripe from "stripe";
import {
	type SupportedCurrency,
	asSupportedCurrency,
	formatSeatPrice,
	planMeta,
} from "@repo/plan-catalog";

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

/** Per-seat Team labels in each supported currency, e.g. `{ usd: "$20 / seat / mo", … }`. */
export type TeamPriceLabels = Record<SupportedCurrency, string>;

/** The catalog fallback label for a currency (Stripe unconfigured / lookup failed). */
function fallbackLabel(currency: SupportedCurrency): string {
	const meta = planMeta("team");
	if (currency === "usd") return meta.priceLabel;
	const eur = meta.priceMonthlyEur;
	return eur != null ? formatSeatPrice(Math.round(eur * 100), "eur", "month") : meta.priceLabel;
}

/**
 * The Team per-seat price labels (USD + EUR), read live from Stripe (the EUR figure from the
 * price's `currency_options`) and cached for an hour. Falls back to the static catalog when
 * Stripe isn't configured or the retrieve fails — the public page must never throw.
 */
export const getTeamPrice = unstable_cache(
	async (): Promise<TeamPriceLabels> => {
		const fallback: TeamPriceLabels = { usd: fallbackLabel("usd"), eur: fallbackLabel("eur") };
		const stripe = getStripe();
		const priceId = process.env.STRIPE_PRICE_TEAM;
		if (!stripe || !priceId) return fallback;
		try {
			const price = await stripe.prices.retrieve(priceId, { expand: ["currency_options"] });
			if (typeof price.unit_amount !== "number") return fallback;
			const interval = price.recurring?.interval;
			const eurUnit = price.currency_options?.eur?.unit_amount;
			// THE ONLY PLACE IN THE REPO THAT STILL HANDS A LIVE STRIPE CURRENCY TO A FORMATTER
			// (#4096), and it now has to narrow it first. `formatSeatPrice` divides by 100, which is
			// right for every currency this product sells in and wrong for a zero-decimal one; before
			// the narrowing, a Team price re-quoted in JPY would have rendered at 1/100 of its value
			// on the public pricing page with nothing to notice it.
			//
			// A code that does not narrow falls back to the static catalog label rather than being
			// rendered anyway. That is the honest answer and not merely the safe one: this slot is
			// LABELLED `usd`, so a price quoted in something else does not belong in it at any scale.
			const code = asSupportedCurrency(price.currency);
			return {
				usd: code ? formatSeatPrice(price.unit_amount, code, interval) : fallback.usd,
				eur:
					typeof eurUnit === "number"
						? formatSeatPrice(eurUnit, "eur", interval)
						: fallback.eur,
			};
		} catch {
			return fallback;
		}
	},
	["pricing-team-price"],
	{ revalidate: 3600 },
);
