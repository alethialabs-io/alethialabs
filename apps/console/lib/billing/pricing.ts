// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live plan pricing — the authoritative price AMOUNT lives in Stripe, read here at
// runtime so the UI can never drift from what's actually charged. The plan catalog
// (`@repo/plan-catalog` priceMonthly/priceLabel) is the FALLBACK only, used when
// Stripe isn't configured (self-managed / community) or a price lookup fails. Mirrors
// the marketing site's pricing-display.ts so both surfaces format prices identically.
// Server-only — never import from a client component.

import { cache } from "react";
import type Stripe from "stripe";
import { type Money, money } from "@repo/format";
import {
	type AiPlanId,
	aiPlanMeta,
	asSupportedCurrency,
	formatPriceLabel,
	formatSeatPrice,
	type PlanId,
	type PriceByCurrency,
	planMeta,
	shortInterval,
	SUPPORTED_CURRENCIES,
	type SupportedCurrency,
} from "@repo/plan-catalog";
import {
	aiPaidTiersEnabled,
	aiPriceIdForTier,
	isStripeConfigured,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";

/**
 * The per-seat (or flat) unit amount in each currency the price is quoted in, as `Money` — so an
 * amount cannot be read out of this object without the currency it belongs to.
 *
 * THIS REPLACES THE `unitAmountUsd` / `unitAmountEur` PAIR (#4176 part b), and the pair is what
 * made the bug: a consumer picked a field by name, the name said USD, and the value came from
 * whichever currency Stripe's price happened to be in. Keyed by `SupportedCurrency`, a consumer
 * that has a currency in hand reads `amounts[currency]` and cannot select the wrong one.
 *
 * A key is ABSENT when Stripe quotes no amount in that currency and the catalog has no fallback
 * figure either (Enterprise, which is "Let's talk"). It is never `null`.
 */
export type LivePriceAmounts = { readonly [C in SupportedCurrency]?: Money };

/** A plan's live price, resolved from Stripe (or the catalog fallback). */
export interface LivePlanPrice {
	/** The unit amount per currency, MINOR units. Absent key = custom/unknown (Enterprise). */
	amounts: LivePriceAmounts;
	/** The currency the Stripe price itself is denominated in (its `currency_options` base). */
	currency: SupportedCurrency;
	interval: string;
	/** Formatted label in the price's base currency, e.g. "$20 / seat / mo" (or the catalog
	 *  fallback label). */
	label: string;
}

/**
 * A catalog `PriceByCurrency` (minor units, per currency) as `LivePriceAmounts`.
 *
 * The catalog and this module now agree on units, so this is a re-labelling and not a
 * conversion — the `/ 100` and `* 100` that used to sit on either side of this boundary are both
 * gone. What it adds is the currency, attached to each amount rather than implied by a key the
 * next consumer has to re-read.
 */
function amountsFrom(prices: PriceByCurrency | undefined): LivePriceAmounts {
	const amounts: { -readonly [C in SupportedCurrency]?: Money } = {};
	for (const code of SUPPORTED_CURRENCIES) {
		const minor = prices?.[code];
		if (minor != null) amounts[code] = money(minor, code);
	}
	return amounts;
}

/**
 * A live Stripe price's amount in every currency we sell in, with the catalog figure standing in
 * for any currency the price does not quote.
 *
 * ONE HELPER FOR BOTH PRODUCTS because the org plan and the AI tier resolved this identically and
 * wrote it out twice, in two near-copies that had already diverged by a `?? null` — the org plan's
 * copy fell back to the catalog for a missing EUR option and the AI copy did too, but each stated
 * the base-currency special case in its own shape. The special case is the only interesting part:
 * a price's OWN `unit_amount` is quoted in `base`, and `currency_options` holds the others.
 *
 * NO ARITHMETIC. Stripe's `unit_amount` is minor units, `Money.minor` is minor units, and the
 * catalog's `priceMonthly` is now minor units too — so the `/ 100` that used to sit on this line
 * (and the `* 100` that undid it in `use-live-plan-price.ts`, and the second `* 100` in the
 * checkout form) have nothing left to convert between.
 */
function liveAmounts(
	price: Stripe.Price,
	base: SupportedCurrency,
	fallback: PriceByCurrency | undefined,
): LivePriceAmounts {
	const amounts: { -readonly [C in SupportedCurrency]?: Money } = {};
	for (const code of SUPPORTED_CURRENCIES) {
		const minor =
			code === base ? price.unit_amount : price.currency_options?.[code]?.unit_amount;
		const resolved = typeof minor === "number" ? minor : fallback?.[code];
		if (resolved != null) amounts[code] = money(resolved, code);
	}
	return amounts;
}

/** The catalog entry rendered as a LivePlanPrice (Stripe unconfigured / lookup failed). */
function fallbackPrice(plan: PlanId): LivePlanPrice {
	const meta = planMeta(plan);
	return {
		amounts: amountsFrom(meta.priceMonthly),
		currency: "usd",
		interval: "month",
		label: meta.priceLabel,
	};
}

/**
 * The live price for a plan, read from Stripe (authoritative) with the catalog as
 * fallback. `community` is free; `enterprise` (invoiced off-Stripe / custom) falls back
 * to its catalog label. Cached per request.
 */
export const getPlanPrice = cache(async (plan: PlanId): Promise<LivePlanPrice> => {
	if (plan === "community" || !isStripeConfigured()) return fallbackPrice(plan);
	try {
		const price = await getStripe().prices.retrieve(priceIdForPlan(plan), {
			expand: ["currency_options"],
		});
		if (typeof price.unit_amount !== "number") return fallbackPrice(plan);
		const baseCurrency = asSupportedCurrency(price.currency);
		if (!baseCurrency) return fallbackPrice(plan);
		const meta = planMeta(plan);
		const label = meta.perSeat
			? formatSeatPrice(price.unit_amount, baseCurrency, price.recurring?.interval)
			: `${formatPriceLabel(price.unit_amount, baseCurrency)} / ${shortInterval(price.recurring?.interval)}`;
		return {
			amounts: liveAmounts(price, baseCurrency, meta.priceMonthly),
			currency: baseCurrency,
			interval: price.recurring?.interval ?? "month",
			label,
		};
	} catch {
		return fallbackPrice(plan);
	}
});

/** Live prices for every plan, keyed by id — the buy-flow's single fetch. */
export type LivePlanPriceMap = Record<PlanId, LivePlanPrice>;

/** Resolve live prices for all plans at once (community/team/enterprise). */
export async function getAllPlanPrices(): Promise<LivePlanPriceMap> {
	const [community, team, enterprise] = await Promise.all([
		getPlanPrice("community"),
		getPlanPrice("team"),
		getPlanPrice("enterprise"),
	]);
	return { community, team, enterprise };
}

// ── Standalone AI tiers ──────────────────────────────────────────────────────────
// The AI subscription (Plus/Max) is a SEPARATE Stripe product from the org plan, priced
// flat (not per-seat). Same authoritative-Stripe / catalog-fallback contract as the org
// plans: the placeholder AI catalog prices are the fallback until STRIPE_PRICE_AI_* are
// configured (pre-cutover), at which point the live amounts take over automatically.

/** An AI tier's live price, resolved from Stripe (or the AI catalog fallback). Same shape as
 *  {@link LivePlanPrice} — the AI product is priced flat rather than per seat, which the label
 *  reflects and the amounts do not. */
export interface LiveAiPrice {
	/** The flat monthly amount per currency, MINOR units. `0` = the free tier; an absent key
	 *  means no amount is known in that currency. */
	amounts: LivePriceAmounts;
	/** The currency the Stripe price itself is denominated in. */
	currency: SupportedCurrency;
	interval: string;
	/** Formatted label, e.g. "$20 / mo" (or the catalog fallback label / "Free"). */
	label: string;
}

/** The AI catalog entry rendered as a LiveAiPrice (Stripe unconfigured / lookup failed). */
function aiFallbackPrice(tier: AiPlanId): LiveAiPrice {
	const meta = aiPlanMeta(tier);
	return {
		amounts: amountsFrom(meta.priceMonthly),
		currency: "usd",
		interval: "month",
		label: meta.priceLabel,
	};
}

/**
 * The live price for a standalone AI tier, read from Stripe (authoritative) with the AI
 * catalog as the fallback. `ai_free` is free; the paid tiers fall back to their placeholder
 * catalog label until BOTH Stripe AI prices are configured (`aiPaidTiersEnabled`) — so this
 * degrades cleanly pre-cutover and never throws (the price-id lookup is guarded). Cached
 * per request.
 */
export const getAiPlanPrice = cache(async (tier: AiPlanId): Promise<LiveAiPrice> => {
	// Free tier, Stripe unconfigured, or the paid AI prices not yet cut over → catalog.
	if (tier === "ai_free" || !isStripeConfigured() || !aiPaidTiersEnabled()) {
		return aiFallbackPrice(tier);
	}
	try {
		const price = await getStripe().prices.retrieve(aiPriceIdForTier(tier), {
			expand: ["currency_options"],
		});
		if (typeof price.unit_amount !== "number") return aiFallbackPrice(tier);
		const baseCurrency = asSupportedCurrency(price.currency);
		if (!baseCurrency) return aiFallbackPrice(tier);
		const meta = aiPlanMeta(tier);
		return {
			amounts: liveAmounts(price, baseCurrency, meta.priceMonthly),
			currency: baseCurrency,
			interval: price.recurring?.interval ?? "month",
			label: `${formatPriceLabel(price.unit_amount, baseCurrency)} / ${shortInterval(price.recurring?.interval)}`,
		};
	} catch {
		return aiFallbackPrice(tier);
	}
});

/** Live prices for every AI tier, keyed by id — the AI hook's single fetch. */
export type LiveAiPriceMap = Record<AiPlanId, LiveAiPrice>;

/** Resolve live prices for all AI tiers at once (free/plus/max). */
export async function getAllAiPrices(): Promise<LiveAiPriceMap> {
	const [ai_free, ai_plus, ai_max] = await Promise.all([
		getAiPlanPrice("ai_free"),
		getAiPlanPrice("ai_plus"),
		getAiPlanPrice("ai_max"),
	]);
	return { ai_free, ai_plus, ai_max };
}
