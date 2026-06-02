import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
	getVineyards,
	type VineyardWithVines,
} from "@/app/server/actions/vineyards";

/** How long cached vineyards are considered fresh (ms). */
const STALE_THRESHOLD = 30_000;

interface VineyardsStore {
	/** Cached vineyards with nested vines (in memory, not persisted). */
	vineyards: VineyardWithVines[];
	isLoading: boolean;
	lastFetchedAt: number | null;

	/** Which vineyard IDs are expanded in the sidebar (persisted). */
	expandedIds: string[];

	/** Fetches vineyards from the server, skipping if data is fresh. */
	fetchVineyards: (force?: boolean) => Promise<void>;
	/** Toggles a single vineyard's expanded state without affecting others. */
	toggleExpanded: (vineyardId: string) => void;
	/** Expands a vineyard (adds to set, never collapses others). */
	expandVineyard: (vineyardId: string) => void;
	/** Removes a vine from the cached data (after deletion). */
	removeVine: (vineyardId: string, vineId: string) => void;
	/** Removes an entire vineyard from the cached data. */
	removeVineyard: (vineyardId: string) => void;
}

export const useVineyardsStore = create<VineyardsStore>()(
	persist(
		(set, get) => ({
			vineyards: [],
			isLoading: false,
			lastFetchedAt: null,
			expandedIds: [],

			fetchVineyards: async (force = false) => {
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
					const { vineyards } = await getVineyards();
					set({
						vineyards,
						lastFetchedAt: Date.now(),
						isLoading: false,
					});
				} catch {
					set({ isLoading: false });
				}
			},

			toggleExpanded: (vineyardId) => {
				set((state) => {
					const ids = new Set(state.expandedIds);
					if (ids.has(vineyardId)) {
						ids.delete(vineyardId);
					} else {
						ids.add(vineyardId);
					}
					return { expandedIds: [...ids] };
				});
			},

			expandVineyard: (vineyardId) => {
				set((state) => {
					if (state.expandedIds.includes(vineyardId)) return state;
					return { expandedIds: [...state.expandedIds, vineyardId] };
				});
			},

			removeVine: (vineyardId, vineId) => {
				set((state) => ({
					vineyards: state.vineyards.map((vy) =>
						vy.id === vineyardId
							? { ...vy, vines: vy.vines.filter((v) => v.id !== vineId) }
							: vy,
					),
				}));
			},

			removeVineyard: (vineyardId) => {
				set((state) => ({
					vineyards: state.vineyards.filter((vy) => vy.id !== vineyardId),
					expandedIds: state.expandedIds.filter((id) => id !== vineyardId),
				}));
			},
		}),
		{
			name: "vineyards-store",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			partialize: (state) => ({
				expandedIds: state.expandedIds,
			}),
		},
	),
);
