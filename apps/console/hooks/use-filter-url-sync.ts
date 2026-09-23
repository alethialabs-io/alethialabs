// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The URL half of the console filter standard: the page's zustand filter store is
// the source of truth, and this hook mirrors it into the search params so filtered
// views are shareable. On mount, params present in the URL win over persisted
// session state (a pasted link shows what it says); afterwards every store change
// rewrites the query string (non-default values only, so a pristine view keeps a
// clean URL). Unrelated params on the page are preserved.
//
// The decode is `lib/query/filter-url-codec.ts`, shared with the list routes' server
// components, which read the same link to prefetch the filtered query (#4980).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import {
	encodeFilterValue,
	filtersFromUrl,
	isDefaultFilterValue,
	type UrlFilterValue,
} from "@/lib/query/filter-url-codec";
import type { FilterStoreState } from "@/lib/stores/create-filter-store";

/**
 * Two-way sync between a page filter store and the URL search params.
 * `paramNames` optionally renames a filter's param (defaults to the key itself).
 *
 * Returns whether the URL has been read into the store yet. It is `false` for the server render
 * and the hydration render — the store still holds its defaults there, whatever the link says —
 * so a list can mark itself busy (`aria-busy`) until the rows it shows answer the URL (#4980).
 */
export function useFilterUrlSync<F extends Record<string, UrlFilterValue>>(
	store: UseBoundStore<StoreApi<FilterStoreState<F>>>,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
): boolean {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const filters = store((s) => s.filters);
	const hydrated = useRef(false);
	const [synced, setSynced] = useState(false);

	const paramFor = (key: string): string => paramNames?.[key] ?? key;

	// Mount: hydrate the store from the URL when any mapped param is present.
	// URL wins over persisted session state so shared links show what they say.
	useEffect(() => {
		if (hydrated.current) return;
		hydrated.current = true;
		const fromUrl = filtersFromUrl(searchParams, defaults, paramNames);
		if (Object.keys(fromUrl).length > 0) store.getState().patch(fromUrl);
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
