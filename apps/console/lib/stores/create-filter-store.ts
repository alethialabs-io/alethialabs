// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory of the console filter standard (see
// lib/query/README.md → "Server-side filters"). One store per list page holds the
// user's filter selections; sessionStorage persistence keeps them across
// navigations, and the page's query hook feeds them (debounced + normalized)
// into a parameterized TanStack Query key.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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

/**
 * Create a sessionStorage-persisted zustand store for one page's filter state.
 * `name` must be unique per page (it is the storage key); bump `version` to
 * invalidate previously persisted shapes when the filter set changes.
 */
export function createFilterStore<F extends Record<string, unknown>>({
	name,
	defaults,
	version = 1,
}: {
	name: string;
	defaults: F;
	version?: number;
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
				storage: createJSONStorage(() => sessionStorage),
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
