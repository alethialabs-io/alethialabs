// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
	getVineyards,
	type VineyardWithVines,
	type VineWithProvider,
} from "@/app/server/actions/vineyards";

/** How long cached vineyards are considered fresh (ms). */
const STALE_THRESHOLD = 30_000;

interface VineyardsStore {
	/** Cached vineyards with nested vines (in memory, not persisted). */
	vineyards: VineyardWithVines[];
	isLoading: boolean;
	error: string | null;
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
	/** Optimistically renames a vineyard in the cached data. */
	renameVineyard: (vineyardId: string, name: string) => void;
	/** Patches a single vine's fields in the cached vineyards array (e.g. from a realtime event). */
	updateVineInPlace: (vineId: string, patch: Partial<VineWithProvider>) => void;
}

export const useVineyardsStore = create<VineyardsStore>()(
	persist(
		(set, get) => ({
			vineyards: [],
			isLoading: false,
			error: null,
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

				set({ isLoading: true, error: null });
				try {
					const { vineyards } = await getVineyards();
					set({
						vineyards,
						lastFetchedAt: Date.now(),
						isLoading: false,
						error: null,
					});
				} catch (err) {
					set({ isLoading: false, error: err instanceof Error ? err.message : "Failed to fetch vineyards" });
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

			renameVineyard: (vineyardId, name) => {
				set((state) => ({
					vineyards: state.vineyards.map((vy) =>
						vy.id === vineyardId ? { ...vy, name } : vy,
					),
				}));
			},

			updateVineInPlace: (vineId, patch) => {
				set((state) => ({
					vineyards: state.vineyards.map((vy) => ({
						...vy,
						vines: vy.vines.map((v) =>
							v.id === vineId ? { ...v, ...patch } : v,
						),
					})),
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
