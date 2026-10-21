"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client hook for live (Stripe-authoritative) plan prices. Fetches the whole price map
// once via the getLivePlanPrices server action (module-cached promise so every consumer
// shares a single request), and returns a plan's amount + label with the static catalog
// value as the synchronous fallback while loading / when Stripe isn't configured. The hook
// stays a server action because its consumers include the public onboarding form, which has
// no org address for the read router to resolve.
//
// The AI tiers' price comes from the read router instead (`billing.liveAiPrices`, prefetched
// with the billing and usage pages — #6127); `aiPriceView` turns its row into the same label.

import { useEffect, useState } from "react";
import { type Money, money } from "@repo/format";
import {
	type AiPlanId,
	aiPlanMeta,
	type PlanId,
	type PriceByCurrency,
	type SupportedCurrency,
	formatPriceLabel,
	formatSeatPrice,
	planMeta,
	shortInterval,
} from "@repo/plan-catalog";
import { getLivePlanPrices } from "@/app/server/actions/billing";
import type {
	LiveAiPrice,
	LivePlanPrice,
	LivePlanPriceMap,
} from "@/lib/billing/pricing";

let pending: Promise<LivePlanPriceMap> | null = null;

/** Fetch the live price map once and share it across all hook consumers. */
function loadPrices(): Promise<LivePlanPriceMap> {
	if (!pending) {
		pending = getLivePlanPrices().catch((e) => {
			pending = null; // allow a retry on the next mount after a transient failure
			throw e;
		});
	}
	return pending;
}

export interface LivePlanPriceView {
	/** Live per-seat/flat monthly amount in the selected currency, MINOR units (catalog fallback
	 *  while loading); null = custom (Enterprise).
	 *
	 *  A `Money` rather than a bare number since #4176 part (b), which is the point of that unit:
	 *  the amount and the currency arrive at a consumer together, so a checkout summary cannot
	 *  render this figure beside a symbol it chose for itself. `currency` below is the currency
	 *  this view was ASKED for and is the same code — it stays because a null `unitAmount` still
	 *  has to say which currency it has no amount in. */
	unitAmount: Money | null;
	/** The currency this view is priced in. */
	currency: SupportedCurrency;
	/** Formatted label for the selected currency, e.g. "€18 / seat / mo". */
	label: string;
	loading: boolean;
}

/**
 * The catalog's own figure for one currency as a `Money` — the synchronous fallback both hooks
 * show while the live map is in flight and when Stripe is unconfigured.
 *
 * `priceMonthly` is minor units, so there is nothing to convert; this exists to attach the
 * currency, and to keep the `?.[currency]` lookup in one place rather than four.
 */
function catalogAmount(
	prices: PriceByCurrency | undefined,
	currency: SupportedCurrency,
): Money | null {
	const minor = prices?.[currency];
	return minor == null ? null : money(minor, currency);
}

/**
 * The live price for a plan in the given currency (default USD), with the catalog value as
 * the loading/offline fallback. The whole price map is fetched once and shared.
 */
export function useLivePlanPrice(
	plan: PlanId,
	currency: SupportedCurrency = "usd",
): LivePlanPriceView {
	const meta = planMeta(plan);
	const [data, setData] = useState<LivePlanPrice | null>(null);

	useEffect(() => {
		let active = true;
		// THE PREVIOUS ROW IS DROPPED BEFORE THE NEW ONE IS FETCHED, and that is a correctness fix
		// rather than tidiness. Without it a plan that CHANGES on a live component keeps the old
		// row in state while the new one is in flight, so the hook reports `loading: false` — its
		// contract for "this is the authoritative price" — beside another plan's amount. The
		// console does exactly that transition: ai-usage-section renders
		// `useLiveAiPrice(ai?.tier ?? "ai_free")`, so every visit shows a paid tier priced "Free"
		// for at least one render once the summary resolves.
		setData(null);
		loadPrices()
			.then((m: LivePlanPriceMap) => {
				if (active) setData(m[plan]);
			})
			.catch(() => {
				// Keep the catalog fallback on failure.
			});
		return () => {
			active = false;
		};
	}, [plan]);

	const unitAmount =
		data?.amounts[currency] ?? catalogAmount(meta.priceMonthly, currency);
	const interval = data?.interval ?? "month";
	const label =
		unitAmount === null
			? meta.priceLabel
			: meta.perSeat
				? formatSeatPrice(unitAmount.minor, currency, interval)
				: `${formatPriceLabel(unitAmount.minor, currency)} / ${shortInterval(interval)}`;

	return { unitAmount, currency, label, loading: data === null };
}

/**
 * The price view of one AI tier from its live row — or from the catalog while there is no row
 * (still loading, Stripe not configured). Pure, so a component that READS the live map over the
 * read router (`orpc.billing.liveAiPrices`, prefetched with the page — #6127) renders the same
 * label this hook does, from the first paint, without a second fetch path.
 */
export function aiPriceView(
	tier: AiPlanId,
	data: LiveAiPrice | null | undefined,
	currency: SupportedCurrency = "usd",
): LivePlanPriceView {
	const meta = aiPlanMeta(tier);
	const unitAmount =
		data?.amounts[currency] ?? catalogAmount(meta.priceMonthly, currency);
	const interval = data?.interval ?? "month";
	// The free tier (unitAmount 0) shows its catalog label ("Free"), not "$0 / mo".
	const label =
		unitAmount === null || unitAmount.minor === 0
			? meta.priceLabel
			: `${formatPriceLabel(unitAmount.minor, currency)} / ${shortInterval(interval)}`;

	return { unitAmount, currency, label, loading: data == null };
}
