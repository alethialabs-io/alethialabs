// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managing an existing Paddle subscription, and reading Paddle's prices: cancel at period end, resume
// (withdraw a scheduled cancellation), change plan, the customer-portal link and the pricing preview.
// Each call goes through the zod-checked client (./api.ts); the webhook (L3) stays the writer of the
// org's billing row — these only ask Paddle to change something.
//
// PRORATION (the one choice this file makes):
//   · an UPGRADE (a higher plan or tier, or more seats) is `prorated_immediately` — Paddle charges
//     the prorated difference now, and the customer gets the higher entitlement now;
//   · a DOWNGRADE (a lower plan or tier, or fewer seats) is `prorated_next_billing_period` — the item
//     changes now, and the prorated credit is carried onto the next renewal instead of being refunded.
//     Paddle has no "change the items at period end" for a subscription; deferring the BILLING is
//     the closest it offers, and it never sends money back mid-period for a change the customer chose.

import { type Money, money } from "@repo/format";
import type { SupportedCurrency } from "@repo/plan-catalog";
import { z } from "zod";
import type { PaidAiTier, PaidPlan } from "@/lib/billing/config";
import type { PaddleClient } from "@/lib/billing/paddle/api";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import { catalogItemForPrice } from "@/lib/billing/paddle/events";
import type { LivePriceList, PurchaseItem } from "@/lib/billing/provider/types";

/** The proration modes this adapter uses. */
export type PaddleProrationMode = "prorated_immediately" | "prorated_next_billing_period";

/** The part of a Paddle subscription the management calls read back. */
const subscriptionSchema = z.looseObject({
	id: z.string(),
	status: z.string(),
	items: z.array(
		z.looseObject({
			quantity: z.number().int(),
			price: z.looseObject({ id: z.string() }),
		}),
	),
	scheduled_change: z.looseObject({ action: z.string(), effective_at: z.string() }).nullable().optional(),
	current_billing_period: z.looseObject({ starts_at: z.string(), ends_at: z.string() }).nullable().optional(),
});

export type PaddleSubscription = z.infer<typeof subscriptionSchema>;

/** The path of one subscription. */
function subPath(subscriptionId: string, suffix = ""): string {
	return `/subscriptions/${encodeURIComponent(subscriptionId)}${suffix}`;
}

/** `GET /subscriptions/{id}`. */
function getPaddleSubscription(client: PaddleClient, subscriptionId: string): Promise<PaddleSubscription> {
	return client.request({ method: "GET", path: subPath(subscriptionId) }, subscriptionSchema);
}

/** Schedules the subscription to cancel when its current billing period ends. */
export function cancelPaddleSubscriptionAtPeriodEnd(
	client: PaddleClient,
	subscriptionId: string,
): Promise<PaddleSubscription> {
	return client.request(
		{ method: "POST", path: subPath(subscriptionId, "/cancel"), body: { effective_from: "next_billing_period" } },
		subscriptionSchema,
	);
}

/**
 * Withdraws a scheduled cancellation: `PATCH` with `scheduled_change: null` (Paddle's `/resume` is for
 * a PAUSED subscription, which this product never creates). Refuses a subscription whose scheduled
 * change is not a cancellation, rather than silently dropping something else.
 */
export async function resumePaddleSubscription(client: PaddleClient, subscriptionId: string): Promise<PaddleSubscription> {
	const current = await getPaddleSubscription(client, subscriptionId);
	if (!current.scheduled_change) return current;
	if (current.scheduled_change.action !== "cancel") {
		throw new Error(`Subscription ${subscriptionId} has a scheduled ${current.scheduled_change.action}, not a cancellation.`);
	}
	return client.request(
		{ method: "PATCH", path: subPath(subscriptionId), body: { scheduled_change: null } },
		subscriptionSchema,
	);
}

/** Rank of each plan and tier, low to high — what decides upgrade vs downgrade. */
const PLAN_RANK: { readonly [P in PaidPlan]: number } = { team: 1, enterprise: 2 };
const TIER_RANK: { readonly [T in PaidAiTier]: number } = { ai_plus: 1, ai_max: 2 };

/** One subscription line as the proration rule reads it. */
export type ProrationSide = { rank: number; quantity: number };

/**
 * The proration mode for a change from `current` to `next` (see the header): a higher rank, or the
 * same rank with more seats, is an upgrade and is billed now; anything else is billed at renewal.
 */
export function prorationModeFor(current: ProrationSide, next: ProrationSide): PaddleProrationMode {
	if (next.rank > current.rank) return "prorated_immediately";
	if (next.rank === current.rank && next.quantity > current.quantity) return "prorated_immediately";
	return "prorated_next_billing_period";
}

/** The rank and quantity of a purchase item. */
function sideOfItem(item: PurchaseItem): ProrationSide {
	switch (item.kind) {
		case "plan":
			return { rank: PLAN_RANK[item.plan], quantity: item.plan === "team" ? Math.max(1, item.seats ?? 1) : 1 };
		case "ai_tier":
			return { rank: TIER_RANK[item.tier], quantity: 1 };
		case "credit_pack":
			throw new Error("A credit pack is not a subscription item.");
	}
}

/** The price id a plan or tier item is sold at. */
function priceIdOf(item: PurchaseItem, config: Pick<PaddleConfig, "prices">): string {
	const { prices } = config;
	const id =
		item.kind === "plan"
			? item.plan === "team"
				? prices.team
				: prices.enterprise
			: item.kind === "ai_tier"
				? item.tier === "ai_plus"
					? prices.aiPlus
					: prices.aiMax
				: undefined;
	if (!id) throw new Error(`No Paddle price is configured for this ${item.kind}.`);
	return id;
}

/**
 * Moves a subscription to `item`, proration per {@link prorationModeFor}. The current line is read
 * from Paddle (not from our row) and must be one of OUR catalog prices in the same slot — a plan is
 * never swapped onto an AI subscription or the reverse.
 */
export async function changePaddleSubscriptionPlan(
	client: PaddleClient,
	subscriptionId: string,
	item: PurchaseItem,
	config: Pick<PaddleConfig, "prices">,
): Promise<{ subscription: PaddleSubscription; proration: PaddleProrationMode }> {
	const current = await getPaddleSubscription(client, subscriptionId);
	const line = current.items.find((i) => catalogItemForPrice(i.price.id, config) !== null);
	const known = line ? catalogItemForPrice(line.price.id, config) : null;
	if (!line || !known) throw new Error(`Subscription ${subscriptionId} carries none of our catalog prices.`);
	const wantSlot = item.kind === "plan" ? "plan" : item.kind === "ai_tier" ? "ai" : null;
	if (known.slot !== wantSlot) throw new Error(`Subscription ${subscriptionId} is not a ${item.kind} subscription.`);
	const currentSide: ProrationSide =
		known.slot === "plan"
			? { rank: PLAN_RANK[known.plan], quantity: line.quantity }
			: { rank: TIER_RANK[known.tier], quantity: line.quantity };
	const next = sideOfItem(item);
	const proration = prorationModeFor(currentSide, next);
	const subscription = await client.request(
		{
			method: "PATCH",
			path: subPath(subscriptionId),
			body: {
				items: [{ price_id: priceIdOf(item, config), quantity: next.quantity }],
				proration_billing_mode: proration,
			},
		},
		subscriptionSchema,
	);
	return { subscription, proration };
}

const portalSchema = z.looseObject({
	urls: z.looseObject({ general: z.looseObject({ overview: z.string().url() }) }),
});

/**
 * A fresh customer-portal link (`POST /customers/{id}/portal-sessions`), authenticated for the
 * customer and deep-linked to `subscriptionIds`. Each link carries a temporary token: never stored,
 * never cached. Paddle's portal has no per-session return URL; the way back is the dashboard setting.
 */
export async function paddlePortalUrl(
	client: PaddleClient,
	customerId: string,
	subscriptionIds: readonly string[],
): Promise<string> {
	const session = await client.request(
		{
			method: "POST",
			path: `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
			body: subscriptionIds.length > 0 ? { subscription_ids: subscriptionIds } : {},
		},
		portalSchema,
	);
	return session.urls.general.overview;
}

/** Minor units as Paddle writes them: a non-negative integer string. */
const minorString = z.string().regex(/^\d+$/);

const previewSchema = z.looseObject({
	currency_code: z.string().nullable(),
	details: z.looseObject({
		line_items: z.array(
			z.looseObject({
				price: z.looseObject({ id: z.string() }),
				unit_totals: z.looseObject({ subtotal: minorString }),
			}),
		),
	}),
});

/**
 * The country each display currency is previewed for (O1): Paddle localises by the buyer's country;
 * our catalog carries a EUR price override for the eurozone and USD elsewhere, so one eurozone country
 * and the US answer the two currencies the console shows.
 */
const PREVIEW_COUNTRY: { readonly [C in SupportedCurrency]: string } = { usd: "US", eur: "DE" };

/** Our currency code for Paddle's, or null for one we do not display. */
function supportedCurrency(code: string | null): SupportedCurrency | null {
	const lower = code?.toLowerCase();
	return lower === "usd" || lower === "eur" ? lower : null;
}

/**
 * The live self-serve prices from Paddle's pricing preview, per currency (O1). Each amount is the
 * per-unit SUBTOTAL — before tax, which Paddle adds at checkout as merchant of record. A currency
 * whose preview fails, or a price Paddle does not return, is simply absent: the caller falls back to
 * the catalog for it.
 */
export async function paddleLivePrices(
	client: PaddleClient,
	config: Pick<PaddleConfig, "prices">,
): Promise<LivePriceList> {
	const configured = [config.prices.team, config.prices.enterprise, config.prices.aiPlus, config.prices.aiMax].filter(
		(id): id is string => Boolean(id),
	);
	const plans: { [P in PaidPlan]?: { [C in SupportedCurrency]?: Money } } = {};
	const aiTiers: { [T in PaidAiTier]?: { [C in SupportedCurrency]?: Money } } = {};
	for (const [currency, country] of Object.entries(PREVIEW_COUNTRY)) {
		let preview: z.infer<typeof previewSchema>;
		try {
			preview = await client.request(
				{
					method: "POST",
					path: "/pricing-preview",
					body: { items: configured.map((price_id) => ({ price_id, quantity: 1 })), address: { country_code: country } },
				},
				previewSchema,
			);
		} catch {
			continue;
		}
		const code = supportedCurrency(preview.currency_code);
		// Paddle answered in a currency other than the one this country stands for: not that currency's price.
		if (code === null || code !== currency) continue;
		for (const line of preview.details.line_items) {
			const item = catalogItemForPrice(line.price.id, config);
			if (!item) continue;
			const amount = money(Number(line.unit_totals.subtotal), code);
			if (item.slot === "plan") plans[item.plan] = { ...plans[item.plan], [code]: amount };
			else aiTiers[item.tier] = { ...aiTiers[item.tier], [code]: amount };
		}
	}
	return { plans, aiTiers };
}
