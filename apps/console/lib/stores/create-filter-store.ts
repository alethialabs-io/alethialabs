// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory of the console filter standard (see
// lib/query/README.md → "Server-side filters"). One store per list page holds the
// user's filter selections; sessionStorage persistence keeps them across
// navigations, and the page's query hook feeds them (debounced + normalized)
// into a parameterized TanStack Query key.

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The shape every page filter store exposes: the filters plus three mutators. */
export interface FilterStoreState<F extends Record<string, unknown>> {
	filters: F;
	/** Set a single filter key. */
	set: <K extends keyof F>(key: K, value: F[K]) => void;
	/** Merge a partial filter update (URL hydration, multi-key changes). */
	patch: (partial: Partial<F>) => void;
	/** Restore every filter to its default. */
	reset: () => void;
}

/** Storage that holds nothing: what a store passed `persist: false` reads and writes. */
const NO_STORAGE: StateStorage = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined,
};

/**
 * Create a sessionStorage-persisted zustand store for one page's filter state.
 * `name` must be unique per page (it is the storage key); bump `version` to
 * invalidate previously persisted shapes when the filter set changes.
 *
 * `persist: false` keeps the store in memory only, so the URL is its only memory across
 * loads (#6320). That is for a page whose route prefetches the first page from the link's
 * filters: a selection remembered in the session is state the server cannot see, so it made the
 * browser's first query key differ from the prefetched one and the first paint changed after
 * hydration (B1). The store is still built here, so it keeps the factory's set/patch/reset.
 */
export function createFilterStore<F extends Record<string, unknown>>({
	name,
	defaults,
	version = 1,
	persist: persisted = true,
}: {
	name: string;
	defaults: F;
	version?: number;
	/** `false`: never written to, nor rehydrated from, sessionStorage. */
	persist?: boolean;
}) {
	return create<FilterStoreState<F>>()(
		persist(
			(set) => ({
				filters: defaults,
				set: (key, value) =>
					set((s) => ({ filters: { ...s.filters, [key]: value } })),
				patch: (partial) =>
					set((s) => ({ filters: { ...s.filters, ...partial } })),
				reset: () => set({ filters: defaults }),
			}),
			{
				name,
				storage: createJSONStorage(() => (persisted ? sessionStorage : NO_STORAGE)),
				version,
				// Persist only the data — the mutators are re-created on load.
				partialize: (s) => ({ filters: s.filters }),
			},
		),
	);
}

/** Order-insensitive equality for one filter value (arrays compare as sets). */
function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		const bs = new Set(b);
		return a.every((x) => bs.has(x));
	}
	return Object.is(a, b);
}

/**
 * How many filters differ from their defaults — drives `FilterBarReset` and
 * the filter-count badges.
 */
export function countActiveFilters<F extends Record<string, unknown>>(
	filters: F,
	defaults: F,
): number {
	return Object.keys(defaults).filter(
		(k) => !sameValue(filters[k], defaults[k]),
	).length;
}
