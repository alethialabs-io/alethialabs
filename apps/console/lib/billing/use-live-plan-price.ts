"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client hook for live (Stripe-authoritative) plan prices. Fetches the whole price map
// once via the getLivePlanPrices server action (module-cached promise so every consumer
// shares a single request), and returns a plan's amount + label with the static catalog
// value as the synchronous fallback while loading / when Stripe isn't configured.

import { useEffect, useState } from "react";
import { type PlanId, planMeta } from "@repo/plan-catalog";
import { getLivePlanPrices } from "@/app/server/actions/billing";
import type { LivePlanPriceMap } from "@/lib/billing/pricing";

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
	/** Live per-seat/flat monthly USD (catalog fallback while loading); null = custom. */
	unitAmountUsd: number | null;
	/** Formatted label, e.g. "$29 / seat / mo" (catalog fallback while loading). */
	label: string;
	loading: boolean;
}

/** The live price for a plan, with the catalog value as the loading/offline fallback. */
export function useLivePlanPrice(plan: PlanId): LivePlanPriceView {
	const meta = planMeta(plan);
	const [data, setData] = useState<{
		unitAmountUsd: number | null;
		label: string;
	} | null>(null);

	useEffect(() => {
		let active = true;
		loadPrices()
			.then((m) => {
				if (active) setData(m[plan]);
			})
			.catch(() => {
				// Keep the catalog fallback on failure.
			});
		return () => {
			active = false;
		};
	}, [plan]);

	return {
		unitAmountUsd: data?.unitAmountUsd ?? meta.priceMonthlyUsd ?? null,
		label: data?.label ?? meta.priceLabel,
		loading: data === null,
	};
}
