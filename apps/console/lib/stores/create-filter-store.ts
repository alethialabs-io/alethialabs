// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory of the console filter standard (see
// lib/query/README.md → "Server-side filters"). One store per list page holds the
// user's filter selections; sessionStorage persistence keeps them across
// navigations, and the page's query hook feeds them (debounced + normalized)
// into a parameterized TanStack Query key.
//
// PERSISTENCE IS SCOPED, NOT GLOBAL (#6730). A store is a module singleton, so one
// definition serves every route that renders its surface: the jobs store backs both
// `/{org}/~/jobs` and every `/{org}/{project}/jobs`, the access and activity stores both
// an org and a project settings page, and every store every org a tab visits. Keyed on
// `name` alone, a search typed on org jobs was restored onto a project's jobs page as
// "No jobs match these filters", and into another org's. So the storage key is
// `<name>:<scope>`, and a store remembers nothing — neither reads nor writes — until
// `enterScope` names one. `useFilterUrlSync` enters the page's pathname on mount, which
// carries the org and the project, so every store reaches the scope through the one
// call F2 of `pnpm check:filter-standard` already requires of it.

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The shape every page filter store exposes: the filters plus their mutators. */
export interface FilterStoreState<F extends Record<string, unknown>> {
	filters: F;
	/** Set a single filter key. */
	set: <K extends keyof F>(key: K, value: F[K]) => void;
	/** Merge a partial filter update (multi-key changes). */
	patch: (partial: Partial<F>) => void;
	/** Restore every filter to its default. */
	reset: () => void;
	/**
	 * Point the store at one scope (a page's pathname). Entering a DIFFERENT scope drops the
	 * filters held in memory for the previous one, then loads what this scope persisted, or
	 * the defaults when it persisted nothing. Re-entering the current scope is a no-op.
	 */
	enterScope: (scope: string) => void;
}

/** Storage that holds nothing: what a store passed `persist: false` reads and writes. */
const NO_STORAGE: StateStorage = {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined,
};

/** The persisted key for one store in one scope. */
export function scopedFilterKey(name: string, scope: string): string {
	return `${name}:${scope}`;
}

/** The tab's sessionStorage, or storage that holds nothing where there is none (the server). */
function sessionStorageOrNothing(): StateStorage {
	try {
		return typeof sessionStorage === "undefined" ? NO_STORAGE : sessionStorage;
	} catch {
		return NO_STORAGE;
	}
}

/**
 * Create a sessionStorage-persisted zustand store for one page's filter state.
 * `name` must be unique per store definition (it prefixes the storage key; the scope
 * completes it); bump `version` to invalidate previously persisted shapes when the
 * filter set changes.
 *
 * `persist: false` keeps the store in memory only, so the URL is its only memory across
 * loads (#6320). That is for a page whose route prefetches the first page from the link's
 * filters: a selection remembered in the session is state the server cannot see, so it made the
 * browser's first query key differ from the prefetched one and the first paint changed after
 * hydration (B1). The store is still built here, so it keeps the factory's mutators — and its
 * scope: entering another scope still drops the in-memory filters of the last one.
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
	// The scope this store currently reads and writes. `null` until a page enters one, and
	// while it is null nothing is persisted or restored.
	let scope: string | null = null;
	// Set while the in-memory filters are dropped on a scope change, so the drop is not
	// written over what the NEW scope persisted before that is read.
	let muted = false;

	const backing = (): StateStorage => (persisted ? sessionStorageOrNothing() : NO_STORAGE);

	/** The storage zustand sees: every key completed with the current scope. */
	const scopedStorage: StateStorage = {
		getItem: (key) => (scope === null ? null : backing().getItem(scopedFilterKey(key, scope))),
		setItem: (key, value) => {
			if (scope === null || muted) return;
			backing().setItem(scopedFilterKey(key, scope), value);
		},
		removeItem: (key) => {
			if (scope === null) return;
			backing().removeItem(scopedFilterKey(key, scope));
		},
	};

	const store = create<FilterStoreState<F>>()(
		persist(
			(set) => ({
				filters: defaults,
				set: (key, value) =>
					set((s) => ({ filters: { ...s.filters, [key]: value } })),
				patch: (partial) =>
					set((s) => ({ filters: { ...s.filters, ...partial } })),
				reset: () => set({ filters: defaults }),
				enterScope: (next) => {
					if (next === scope) return;
					const left = scope;
					scope = next;
					// Filters held for another scope never carry over. The very first entry keeps
					// what is in memory: nothing has been persisted or restored yet, so that is
					// the defaults on a page (and whatever a test planted before mounting).
					if (left !== null) {
						muted = true;
						try {
							set({ filters: defaults });
						} finally {
							muted = false;
						}
					}
					// sessionStorage is synchronous, so this has applied before it returns.
					void store.persist.rehydrate();
				},
			}),
			{
				name,
				storage: createJSONStorage(() => scopedStorage),
				version,
				// Nothing to restore until a scope is entered.
				skipHydration: true,
				// Persist only the data — the mutators are re-created on load.
				partialize: (s) => ({ filters: s.filters }),
			},
		),
	);
	return store;
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
