// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live plan pricing — the authoritative price AMOUNT lives in Stripe, read here at
// runtime so the UI can never drift from what's actually charged. The plan catalog
// (`@repo/plan-catalog` priceMonthlyUsd/priceLabel) is the FALLBACK only, used when
// Stripe isn't configured (self-managed / community) or a price lookup fails. Mirrors
// the marketing site's pricing-display.ts so both surfaces format prices identically.
// Server-only — never import from a client component.

import { cache } from "react";
import {
	formatMoney,
	formatSeatPrice,
	type PlanId,
	planMeta,
	shortInterval,
} from "@repo/plan-catalog";
import { isStripeConfigured, type PaidPlan, priceIdForPlan } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";

/** A plan's live price, resolved from Stripe (or the catalog fallback). */
export interface LivePlanPrice {
	/** Per-seat (or flat) monthly amount in USD; null = custom/unknown (Enterprise). */
	unitAmountUsd: number | null;
	currency: string;
	interval: string;
	/** Formatted label, e.g. "$29 / seat / mo" (or the catalog fallback label). */
	label: string;
}

/** The catalog entry rendered as a LivePlanPrice (Stripe unconfigured / lookup failed). */
function fallbackPrice(plan: PlanId): LivePlanPrice {
	const meta = planMeta(plan);
	return {
		unitAmountUsd: meta.priceMonthlyUsd ?? null,
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
		const price = await getStripe().prices.retrieve(priceIdForPlan(plan as PaidPlan));
		if (typeof price.unit_amount !== "number") return fallbackPrice(plan);
		const meta = planMeta(plan);
		const label = meta.perSeat
			? formatSeatPrice(price.unit_amount, price.currency, price.recurring?.interval)
			: `${formatMoney(price.unit_amount, price.currency)} / ${shortInterval(price.recurring?.interval)}`;
		return {
			unitAmountUsd: price.unit_amount / 100,
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
