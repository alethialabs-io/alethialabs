// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The URL half of the console filter standard: the link says which view the page shows, the
// page's zustand filter store holds that view while the page is open, and this hook keeps the
// two equal. Every store change rewrites the query string (non-default values only, so a
// pristine view keeps a clean URL). Unrelated params on the page are preserved.
//
// On mount it does two things, in this order:
//
//   1. SCOPE (#6730). The store enters this page's pathname, which names the org and, on a
//      project page, the project. A selection made on `/{org}/~/jobs` is not this page's
//      selection when this page is `/{org}/{project}/jobs`, nor another org's.
//   2. THE LINK REPLACES THE STORE; IT IS NEVER PATCHED OVER IT (#6814). The store is set to
//      `filterStateFromUrl`: the defaults with the link's filter params applied. A param the
//      link does not carry is that filter's default, not whatever the store held. Merging was
//      the defect, twice: a `?statuses=CANCELLED` link inherited a remembered `search`, and a
//      bare link kept the selection of an earlier visit to the same page. Both are views the
//      link does not describe, and views the server, which prefetches from the link alone,
//      had not prefetched either.
//
//      The one exception is a store built with `persist: true`. For it a link carrying NONE of
//      the store's filter params (a bare URL, or unrelated params only) leaves what this scope
//      persisted in place. A link carrying any of them still replaces.
//
// The decode is `lib/query/filter-url-codec.ts`, shared with the list routes' server
// components, which read the same link to prefetch the filtered query (#4980).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import {
	decodeFilterValue,
	encodeFilterValue,
	filterStateFromUrl,
	filtersFromUrl,
	isDefaultFilterValue,
	type UrlFilterValue,
} from "@/lib/query/filter-url-codec";
import type { FilterStoreState } from "@/lib/stores/create-filter-store";

/**
 * Two-way sync between a page filter store and the URL search params.
 * `paramNames` optionally renames a filter's param (defaults to the key itself).
 *
 * `options.retiredParams` names params an older version of the page wrote: the page reads
 * them itself (to keep old links working) and this hook removes them on its next URL write, so
 * a link is never re-shared carrying both the old shape and the new one.
 *
 * `options.resetParams` names params whose value only means something for the current filters:
 * the page number, the selected row (`lib/query/view-url-params.ts`). They are removed on a URL
 * write that CHANGES a filter, and kept on any other write, so `?statuses=FAILED&page=3` opens
 * page 3 and picking another status goes back to the first page.
 *
 * Returns whether the URL has been read into the store yet. It is `false` for the server render
 * and the hydration render — the store still holds its defaults there, whatever the link says —
 * so a list can mark itself busy (`aria-busy`) until the rows it shows answer the URL (#4980).
 */
export function useFilterUrlSync<F extends Record<string, UrlFilterValue>>(
	store: UseBoundStore<StoreApi<FilterStoreState<F>>>,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
	options?: { retiredParams?: readonly string[]; resetParams?: readonly string[] },
): boolean {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const filters = store((s) => s.filters);
	// The scope the link was last read under; `null` until the first read.
	const entered = useRef<string | null>(null);
	const [synced, setSynced] = useState(false);

	const paramFor = (key: string): string => paramNames?.[key] ?? key;

	// Mount, and a pathname change under a mounted page: enter the scope, then let the link
	// REPLACE the store's state (see the header for why this is never a merge).
	useEffect(() => {
		if (entered.current === pathname) return;
		entered.current = pathname;
		const state = store.getState();
		state.enterScope(pathname);
		const named = Object.keys(filtersFromUrl(searchParams, defaults, paramNames)).length > 0;
		if (named || !state.remembers) {
			state.replace(filterStateFromUrl(searchParams, defaults, paramNames));
		}
		setSynced(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the scope only
	}, [pathname]);

	// Store → URL: rewrite the query string whenever the filters change. Reads the
	// filters fresh from the store (the subscription is only the trigger) so the
	// first run after mount-hydration sees the patched state, not the pre-patch
	// snapshot — otherwise a shared link's params would be wiped and rewritten.
	useEffect(() => {
		if (entered.current === null) return;
		const fresh = store.getState().filters;
		const params = new URLSearchParams(searchParams.toString());
		for (const retired of options?.retiredParams ?? []) params.delete(retired);
		let filterChanged = false;
		for (const key of Object.keys(defaults)) {
			const param = paramFor(key);
			const raw = params.get(param);
			const inUrl = raw === null ? defaults[key] : decodeFilterValue(raw, defaults[key]);
			if (!isDefaultFilterValue(fresh[key], inUrl)) filterChanged = true;
			if (isDefaultFilterValue(fresh[key], defaults[key])) params.delete(param);
			else params.set(param, encodeFilterValue(fresh[key]));
		}
		if (filterChanged) {
			for (const dependent of options?.resetParams ?? []) params.delete(dependent);
		}
		const next = params.toString();
		if (next === searchParams.toString()) return;
		router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the filters only
	}, [filters]);

	return synced;
}
