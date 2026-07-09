"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client hook for live (Stripe-authoritative) plan prices. Fetches the whole price map
// once via the getLivePlanPrices server action (module-cached promise so every consumer
// shares a single request), and returns a plan's amount + label with the static catalog
// value as the synchronous fallback while loading / when Stripe isn't configured.

import { useEffect, useState } from "react";
import {
	type AiPlanId,
	aiPlanMeta,
	type PlanId,
	type SupportedCurrency,
	formatMoney,
	formatSeatPrice,
	planMeta,
	shortInterval,
} from "@repo/plan-catalog";
import { getLiveAiPrices, getLivePlanPrices } from "@/app/server/actions/billing";
import type {
	LiveAiPrice,
	LiveAiPriceMap,
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
	/** Live per-seat/flat monthly amount in the selected currency (catalog fallback while
	 *  loading); null = custom (Enterprise). */
	unitAmount: number | null;
	/** The currency this view is priced in. */
	currency: SupportedCurrency;
	/** Formatted label for the selected currency, e.g. "€18 / seat / mo". */
	label: string;
	loading: boolean;
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
		currency === "eur"
			? (data?.unitAmountEur ?? meta.priceMonthlyEur ?? null)
			: (data?.unitAmountUsd ?? meta.priceMonthlyUsd ?? null);
	const interval = data?.interval ?? "month";
	const label =
		unitAmount == null
			? meta.priceLabel
			: meta.perSeat
				? formatSeatPrice(Math.round(unitAmount * 100), currency, interval)
				: `${formatMoney(Math.round(unitAmount * 100), currency)} / ${shortInterval(interval)}`;

	return { unitAmount, currency, label, loading: data === null };
}

let aiPending: Promise<LiveAiPriceMap> | null = null;

/** Fetch the live AI price map once and share it across all hook consumers. */
function loadAiPrices(): Promise<LiveAiPriceMap> {
	if (!aiPending) {
		aiPending = getLiveAiPrices().catch((e) => {
			aiPending = null; // allow a retry on the next mount after a transient failure
			throw e;
		});
	}
	return aiPending;
}

/**
 * The live price for a standalone AI tier in the given currency (default USD), with the AI
 * catalog value as the loading/offline fallback. The whole AI price map is fetched once and
 * shared. Free renders "Free"; the paid tiers show the Stripe amount (placeholder catalog
 * price pre-cutover). Formats identically to the org-plan hook.
 */
export function useLiveAiPrice(
	tier: AiPlanId,
	currency: SupportedCurrency = "usd",
): LivePlanPriceView {
	const meta = aiPlanMeta(tier);
	const [data, setData] = useState<LiveAiPrice | null>(null);

	useEffect(() => {
		let active = true;
		loadAiPrices()
			.then((m: LiveAiPriceMap) => {
				if (active) setData(m[tier]);
			})
			.catch(() => {
				// Keep the catalog fallback on failure.
			});
		return () => {
			active = false;
		};
	}, [tier]);

	const unitAmount =
		currency === "eur"
			? (data?.unitAmountEur ?? meta.priceMonthlyEur ?? null)
			: (data?.unitAmountUsd ?? meta.priceMonthlyUsd ?? null);
	const interval = data?.interval ?? "month";
	// The free tier (unitAmount 0) shows its catalog label ("Free"), not "$0 / mo".
	const label =
		unitAmount == null || unitAmount === 0
			? meta.priceLabel
			: `${formatMoney(Math.round(unitAmount * 100), currency)} / ${shortInterval(interval)}`;

	return { unitAmount, currency, label, loading: data === null };
}
