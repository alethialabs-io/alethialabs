// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import type { RegionPrices } from "@/app/server/actions/pricing";
import { getRegionPrices } from "@/app/server/actions/pricing";

const PRICE_CACHE_TTL = 5 * 60 * 1000;

interface PricingStore {
	prices: RegionPrices | null;
	loadingPrices: boolean;
	isLoading: boolean;
	error: string | null;
	_priceCache: Map<string, { data: RegionPrices; fetchedAt: number }>;

	setSubmitting: () => void;
	setError: (error: string | null) => void;
	fetchPrices: (region: string) => Promise<void>;
	reset: () => void;
}

export const usePricingStore = create<PricingStore>((set, get) => ({
	prices: null,
	loadingPrices: false,
	isLoading: false,
	error: null,
	_priceCache: new Map(),

	setSubmitting: () => set({ isLoading: true, error: null }),
	setError: (error) => set({ error, isLoading: false }),

	fetchPrices: async (region) => {
		const cached = get()._priceCache.get(region);
		if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) {
			set({ prices: cached.data, loadingPrices: false });
			return;
		}

		set({ loadingPrices: true, error: null });
		try {
			const prices = await getRegionPrices(region);
			const cache = new Map(get()._priceCache);
			cache.set(region, { data: prices, fetchedAt: Date.now() });
			set({ prices, loadingPrices: false, _priceCache: cache, error: null });
		} catch (err) {
			set({ loadingPrices: false, error: err instanceof Error ? err.message : "Failed to fetch prices" });
		}
	},

	reset: () =>
		set({
			prices: null,
			loadingPrices: false,
			isLoading: false,
			error: null,
			_priceCache: new Map(),
		}),
}));
