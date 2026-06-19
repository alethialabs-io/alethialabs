// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
	getZones,
	type ZoneWithSpecs,
	type SpecWithProvider,
} from "@/app/server/actions/zones";

/** How long cached zones are considered fresh (ms). */
const STALE_THRESHOLD = 30_000;

interface ZonesStore {
	/** Cached zones with nested specs (in memory, not persisted). */
	zones: ZoneWithSpecs[];
	isLoading: boolean;
	error: string | null;
	lastFetchedAt: number | null;

	/** Which zone IDs are expanded in the sidebar (persisted). */
	expandedIds: string[];

	/** Fetches zones from the server, skipping if data is fresh. */
	fetchZones: (force?: boolean) => Promise<void>;
	/** Toggles a single zone's expanded state without affecting others. */
	toggleExpanded: (zoneId: string) => void;
	/** Expands a zone (adds to set, never collapses others). */
	expandZone: (zoneId: string) => void;
	/** Removes a spec from the cached data (after deletion). */
	removeSpec: (zoneId: string, specId: string) => void;
	/** Removes an entire zone from the cached data. */
	removeZone: (zoneId: string) => void;
	/** Optimistically renames a zone in the cached data. */
	renameZone: (zoneId: string, name: string) => void;
	/** Patches a single spec's fields in the cached zones array (e.g. from a realtime event). */
	updateSpecInPlace: (specId: string, patch: Partial<SpecWithProvider>) => void;
}

export const useZonesStore = create<ZonesStore>()(
	persist(
		(set, get) => ({
			zones: [],
			isLoading: false,
			error: null,
			lastFetchedAt: null,
			expandedIds: [],

			fetchZones: async (force = false) => {
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
					const { zones } = await getZones();
					set({
						zones,
						lastFetchedAt: Date.now(),
						isLoading: false,
						error: null,
					});
				} catch (err) {
					set({ isLoading: false, error: err instanceof Error ? err.message : "Failed to fetch zones" });
				}
			},

			toggleExpanded: (zoneId) => {
				set((state) => {
					const ids = new Set(state.expandedIds);
					if (ids.has(zoneId)) {
						ids.delete(zoneId);
					} else {
						ids.add(zoneId);
					}
					return { expandedIds: [...ids] };
				});
			},

			expandZone: (zoneId) => {
				set((state) => {
					if (state.expandedIds.includes(zoneId)) return state;
					return { expandedIds: [...state.expandedIds, zoneId] };
				});
			},

			removeSpec: (zoneId, specId) => {
				set((state) => ({
					zones: state.zones.map((z) =>
						z.id === zoneId
							? { ...z, specs: z.specs.filter((s) => s.id !== specId) }
							: z,
					),
				}));
			},

			removeZone: (zoneId) => {
				set((state) => ({
					zones: state.zones.filter((z) => z.id !== zoneId),
					expandedIds: state.expandedIds.filter((id) => id !== zoneId),
				}));
			},

			renameZone: (zoneId, name) => {
				set((state) => ({
					zones: state.zones.map((z) =>
						z.id === zoneId ? { ...z, name } : z,
					),
				}));
			},

			updateSpecInPlace: (specId, patch) => {
				set((state) => ({
					zones: state.zones.map((z) => ({
						...z,
						specs: z.specs.map((s) =>
							s.id === specId ? { ...s, ...patch } : s,
						),
					})),
				}));
			},
		}),
		{
			name: "zones-store",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			partialize: (state) => ({
				expandedIds: state.expandedIds,
			}),
		},
	),
);
