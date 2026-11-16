// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The URL half of the console filter standard: the page's zustand filter store is
// the source of truth, and this hook mirrors it into the search params so filtered
// views are shareable. Afterwards every store change rewrites the query string
// (non-default values only, so a pristine view keeps a clean URL). Unrelated params on
// the page are preserved.
//
// On mount it does two things, in this order (#6730):
//
//   1. SCOPE. The store enters this page's pathname, which names the org and, on a project
//      page, the project. A selection made on `/{org}/~/jobs` is not this page's selection
//      when this page is `/{org}/{project}/jobs`, nor another org's.
//   2. PRECEDENCE. A link that carries ANY of the store's filter params shows exactly that
//      link's view: the defaults with those params applied, and nothing remembered from the
//      session. Only a link carrying none of them (a bare URL, or one with unrelated params
//      only) restores what this scope persisted. Merging the two was the defect: a
//      `?statuses=CANCELLED` link also inherited a remembered `search`, so it showed a view the
//      link did not describe — and one the server, which prefetches from the link alone
//      (`filterStateFromUrl`), had not prefetched either.
//
// The decode is `lib/query/filter-url-codec.ts`, shared with the list routes' server
// components, which read the same link to prefetch the filtered query (#4980).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import {
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
 * `options.retiredParams` names params an older version of the page wrote: the page reads
 * them itself (to keep old links working) and this hook removes them on its next URL write, so
 * a link is never re-shared carrying both the old shape and the new one.
 *
 * Returns whether the URL has been read into the store yet. It is `false` for the server render
 * and the hydration render — the store still holds its defaults there, whatever the link says —
 * so a list can mark itself busy (`aria-busy`) until the rows it shows answer the URL (#4980).
 */
export function useFilterUrlSync<F extends Record<string, UrlFilterValue>>(
	store: UseBoundStore<StoreApi<FilterStoreState<F>>>,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
	options?: { retiredParams?: readonly string[] },
): boolean {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const filters = store((s) => s.filters);
	const hydrated = useRef(false);
	const [synced, setSynced] = useState(false);

	const paramFor = (key: string): string => paramNames?.[key] ?? key;

	// Mount: enter this page's scope, then let a link that names any filter REPLACE the state
	// (see the header for why this is not a merge).
	useEffect(() => {
		if (hydrated.current) return;
		hydrated.current = true;
		store.getState().enterScope(pathname);
		const fromUrl = filtersFromUrl(searchParams, defaults, paramNames);
		if (Object.keys(fromUrl).length > 0) {
			store.getState().patch(filterStateFromUrl(searchParams, defaults, paramNames));
		}
		setSynced(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only hydration
	}, []);

	// Store → URL: rewrite the query string whenever the filters change. Reads the
	// filters fresh from the store (the subscription is only the trigger) so the
	// first run after mount-hydration sees the patched state, not the pre-patch
	// snapshot — otherwise a shared link's params would be wiped and rewritten.
	useEffect(() => {
		if (!hydrated.current) return;
		const fresh = store.getState().filters;
		const params = new URLSearchParams(searchParams.toString());
		for (const retired of options?.retiredParams ?? []) params.delete(retired);
		for (const key of Object.keys(defaults)) {
			const param = paramFor(key);
			if (isDefaultFilterValue(fresh[key], defaults[key])) params.delete(param);
			else params.set(param, encodeFilterValue(fresh[key]));
		}
		const next = params.toString();
		if (next === searchParams.toString()) return;
		router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the filters only
	}, [filters]);

	return synced;
}
