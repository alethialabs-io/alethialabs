// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { getClusters, type ClusterData } from "@/app/server/actions/clusters";

const STALE_THRESHOLD = 30_000;

interface ClustersStore {
	clusters: ClusterData[];
	isLoading: boolean;
	error: string | null;
	lastFetchedAt: number | null;
	fetchClusters: (force?: boolean) => Promise<void>;
}

export const useClustersStore = create<ClustersStore>()((set, get) => ({
	clusters: [],
	isLoading: false,
	error: null,
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

		set({ isLoading: true, error: null });
		try {
			const clusters = await getClusters();
			set({ clusters, lastFetchedAt: Date.now(), isLoading: false, error: null });
		} catch (err) {
			set({ isLoading: false, error: err instanceof Error ? err.message : "Failed to fetch clusters" });
		}
	},
}));
