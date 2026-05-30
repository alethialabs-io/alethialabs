import { create } from "zustand";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import type { RegionPrices } from "@/app/server/actions/pricing";
import { getRegionPrices } from "@/app/server/actions/pricing";

interface VineStore {
	awsConnected: boolean;
	awsResources: CachedAwsResources | null;
	prices: RegionPrices | null;
	loadingPrices: boolean;
	submitted: boolean;
	isLoading: boolean;
	error: string | null;

	set: (partial: Partial<VineStore>) => void;
	fetchPrices: (region: string) => Promise<void>;
	reset: () => void;
}

export const useVineStore = create<VineStore>((set) => ({
	awsConnected: false,
	awsResources: null,
	prices: null,
	loadingPrices: false,
	submitted: false,
	isLoading: false,
	error: null,

	set: (partial) => set(partial),

	fetchPrices: async (region) => {
		set({ loadingPrices: true });
		try {
			const prices = await getRegionPrices(region);
			set({ prices, loadingPrices: false });
		} catch {
			set({ loadingPrices: false });
		}
	},

	reset: () =>
		set({
			prices: null,
			loadingPrices: false,
			submitted: false,
			isLoading: false,
			error: null,
		}),
}));
