// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-page filter-store factory of the console filter standard (see
// lib/query/README.md → "Server-side filters"). One store per list page holds the
// user's filter selections, and the page's query hook feeds them (debounced + normalized)
// into a parameterized TanStack Query key.
//
// THE URL IS A STORE'S ONLY MEMORY, UNLESS IT ASKS FOR ANOTHER (#6814). A store is built
// with `persist: false` by default: nothing is written to, or read from, sessionStorage.
// A list route prefetches its first page from the link alone (`filterStateFromUrl`), so a
// selection remembered anywhere else is state the server cannot see — the browser's first
// query key then differs from the prefetched one and the first paint changes after
// hydration (#6320). `useFilterUrlSync` therefore REPLACES a store's filters with the
// link's on mount (`replace`), and never merges a link over what the store held.
//
// EVERY STORE HAS A SCOPE KEY, PERSISTED OR NOT (#6730). A store is a module singleton, so
// one definition serves every route that renders its surface: the jobs store backs both
// `/{org}/~/jobs` and every `/{org}/{project}/jobs`, the access and activity stores both
// an org and a project settings page, and every store every org a tab visits. The scope
// key is the page's pathname, which carries the org and the project; `useFilterUrlSync`
// enters it on mount through the one call F2 of `pnpm check:filter-standard` already
// requires. Entering a different scope drops the filters held in memory for the last one.
// A store built with `persist: true` additionally keys what it writes on `<name>:<scope>`,
// and reads and writes nothing until a scope is entered.
//
// The scope is NOT one of the filters. Which org and which project a list belongs to is a
// predicate the server applies to the rows pass AND to the facet pass; a filter is applied
// to the rows pass only. See the README's "Scope is a predicate, never a filter".

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The shape every page filter store exposes: the filters plus their mutators. */
export interface FilterStoreState<F extends Record<string, unknown>> {
	filters: F;
	/** Set a single filter key. */
	set: <K extends keyof F>(key: K, value: F[K]) => void;
	/** Merge a partial filter update (multi-key changes). */
	patch: (partial: Partial<F>) => void;
	/**
	 * Hold exactly `filters`: the whole state at once, nothing kept from before. This is how a
	 * link's view lands in the store (`useFilterUrlSync`). Handing it what the store already
	 * holds changes nothing, so subscribers are not told of a change that did not happen.
	 */
	replace: (filters: F) => void;
	/** Restore every filter to its default. */
	reset: () => void;
	/**
	 * Point the store at one scope (a page's pathname). Entering a DIFFERENT scope drops the
	 * filters held in memory for the previous one, then loads what this scope persisted, or
	 * the defaults when it persisted nothing. Re-entering the current scope is a no-op.
	 */
	enterScope: (scope: string) => void;
	/**
	 * Whether this store keeps a scope's filters in sessionStorage (`persist: true`). When it
	 * does not, the URL is its only memory and a link with no filter params means the defaults.
	 */
	remembers: boolean;
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
 * Create the zustand store for one page's filter state.
 *
 * By default it lives in memory only and the URL is its only memory across loads: the route
 * prefetches the first page from the link's filters, and a selection remembered in the session
 * is state the server cannot see (#6320, #6814).
 *
 * `persist: true` is the opt-in for a surface whose route does NOT prefetch from the link and
 * that wants a bare URL to bring back the last selection made on that same page. It writes to
 * sessionStorage under `<name>:<scope>`, so `name` must be unique per store definition; bump
 * `version` to invalidate previously persisted shapes when the filter set changes. Neither
 * `name` nor `version` has any effect on a store that does not persist.
 *
 * Either way the store has a scope: entering another one drops the in-memory filters of the last.
 */
export function createFilterStore<F extends Record<string, unknown>>({
	name,
	defaults,
	version = 1,
	persist: persisted = false,
}: {
	name: string;
	defaults: F;
	version?: number;
	/** `true`: written to, and rehydrated from, sessionStorage under the entered scope. */
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
				replace: (filters) =>
					set((s) => (sameFilters(s.filters, filters) ? s : { filters })),
				reset: () => set({ filters: defaults }),
				remembers: persisted,
				enterScope: (next) => {
					if (next === scope) return;
					const left = scope;
					scope = next;
					// Filters held for another scope never carry over. The very first entry keeps
					// what is in memory: no scope has been left yet, so there is nothing of
					// another scope's to drop.
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

/** Exact equality of two filter states: the same keys, and each value the same in the same order. */
function sameFilters<F extends Record<string, unknown>>(a: F, b: F): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => {
		const x = a[key];
		const y = b[key];
		if (Array.isArray(x) && Array.isArray(y)) {
			return x.length === y.length && x.every((item, i) => Object.is(item, y[i]));
		}
		return Object.is(x, y);
	});
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
