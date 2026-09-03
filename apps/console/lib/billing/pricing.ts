// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live plan pricing — the authoritative price AMOUNT lives in Stripe, read here at
// runtime so the UI can never drift from what's actually charged. The plan catalog
// (`@repo/plan-catalog` priceMonthlyUsd/priceLabel) is the FALLBACK only, used when
// Stripe isn't configured (self-managed / community) or a price lookup fails.
// Server-only — never import from a client component.
//
// EVERY DIVISION IN THIS FILE ASKS `stripeChargeDivisor` (#4096). Each `LivePlanPrice`
// carries a Stripe amount twice — once as the `label` string, once as a `unitAmount*`
// number — and BOTH used to read `price.unit_amount` through an unconditional `/ 100`.
// They were two INDEPENDENT divisions of the same undivided input, not a compound one:
// nothing here was ever divided by 10,000, and "fixing" it by deleting one of them would
// have broken the other path outright. Both now take the divisor from Stripe's own charge
// table in `packages/format/src/minor-units.ts`, which is the only place in the repo that
// answers the question.
//
// The label goes through `@repo/format`'s `formatMoney`, not `@repo/plan-catalog`'s
// compact one: the console already depends on `@repo/format`, `@repo/format` owns the
// divisor, and this is the register the console's other billing surfaces already print
// (`$20.00 / seat / mo`, not `$20 / seat / mo`).

import { cache } from "react";
import { formatMoney, stripeChargeDivisor } from "@repo/format";
import {
	type AiPlanId,
	aiPlanMeta,
	type PlanId,
	planMeta,
	shortInterval,
} from "@repo/plan-catalog";
import {
	aiPaidTiersEnabled,
	aiPriceIdForTier,
	isStripeConfigured,
	type PaidPlan,
	priceIdForPlan,
} from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";

/** A plan's live price, resolved from Stripe (or the catalog fallback). */
export interface LivePlanPrice {
	/** Per-seat (or flat) monthly amount in USD; null = custom/unknown (Enterprise). */
	unitAmountUsd: number | null;
	/** Same, in EUR (from the price's `currency_options`); null when there's no EUR option. */
	unitAmountEur: number | null;
	currency: string;
	interval: string;
	/** Formatted USD label, e.g. "$20.00 / seat / mo" (or the catalog fallback label). */
	label: string;
}

/** The catalog entry rendered as a LivePlanPrice (Stripe unconfigured / lookup failed). */
function fallbackPrice(plan: PlanId): LivePlanPrice {
	const meta = planMeta(plan);
	return {
		unitAmountUsd: meta.priceMonthlyUsd ?? null,
		unitAmountEur: meta.priceMonthlyEur ?? null,
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
		const meta = planMeta(plan);
		// ISO 4217 for `@repo/format`; Stripe spells a currency in lower case.
		const code = price.currency.toUpperCase();
		const amount = formatMoney(price.unit_amount, code);
		const per = shortInterval(price.recurring?.interval);
		const label = meta.perSeat ? `${amount} / seat / ${per}` : `${amount} / ${per}`;
		const eurAmount = price.currency_options?.eur?.unit_amount;
		return {
			unitAmountUsd: price.unit_amount / stripeChargeDivisor(code),
			// A `currency_options.eur` amount is quoted in EUR whatever the price's own currency is,
			// so its divisor is EUR's — named rather than assumed, even though EUR resolves to 100.
			unitAmountEur:
				typeof eurAmount === "number"
					? eurAmount / stripeChargeDivisor("EUR")
					: (meta.priceMonthlyEur ?? null),
			currency: price.currency,
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

/** An AI tier's live price, resolved from Stripe (or the AI catalog fallback). */
export interface LiveAiPrice {
	/** Flat monthly amount in USD; null = unknown. `0` = the free tier. */
	unitAmountUsd: number | null;
	/** Same, in EUR (from the price's `currency_options`); null when there's no EUR option. */
	unitAmountEur: number | null;
	currency: string;
	interval: string;
	/** Formatted label, e.g. "$20.00 / mo" (or the catalog fallback label / "Free"). */
	label: string;
}

/** The AI catalog entry rendered as a LiveAiPrice (Stripe unconfigured / lookup failed). */
function aiFallbackPrice(tier: AiPlanId): LiveAiPrice {
	const meta = aiPlanMeta(tier);
	return {
		unitAmountUsd: meta.priceMonthlyUsd ?? null,
		unitAmountEur: meta.priceMonthlyEur ?? null,
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
		const meta = aiPlanMeta(tier);
		const code = price.currency.toUpperCase();
		const eurAmount = price.currency_options?.eur?.unit_amount;
		return {
			unitAmountUsd: price.unit_amount / stripeChargeDivisor(code),
			unitAmountEur:
				typeof eurAmount === "number"
					? eurAmount / stripeChargeDivisor("EUR")
					: (meta.priceMonthlyEur ?? null),
			currency: price.currency,
			interval: price.recurring?.interval ?? "month",
			label: `${formatMoney(price.unit_amount, code)} / ${shortInterval(price.recurring?.interval)}`,
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
