import { create } from "zustand";
import { getClusters, type ClusterData } from "@/app/server/actions/clusters";

const STALE_THRESHOLD = 30_000;

interface ClustersStore {
	clusters: ClusterData[];
	isLoading: boolean;
	lastFetchedAt: number | null;
	fetchClusters: (force?: boolean) => Promise<void>;
}

export const useClustersStore = create<ClustersStore>()((set, get) => ({
	clusters: [],
	isLoading: false,
	lastFetchedAt: null,

	fetchClusters: async (force = false) => {
		const { lastFetchedAt, isLoading } = get();
		if (isLoading) return;
		if (
			!force &&
			lastFetchedAt &&
			Date.now() - lastFetchedAt < STALE_THRESHOLD
		) {
			return;
		}

		set({ isLoading: true });
		try {
			const clusters = await getClusters();
			set({ clusters, lastFetchedAt: Date.now(), isLoading: false });
		} catch {
			set({ isLoading: false });
		}
	},
}));
