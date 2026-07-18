// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The URL half of the console filter standard: the page's zustand filter store is
// the source of truth, and this hook mirrors it into the search params so filtered
// views are shareable. On mount, params present in the URL win over persisted
// session state (a pasted link shows what it says); afterwards every store change
// rewrites the query string (non-default values only, so a pristine view keeps a
// clean URL). Unrelated params on the page are preserved.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import type { FilterStoreState } from "@/lib/stores/create-filter-store";

/** Filter shapes the URL codec can represent. */
export type UrlFilterValue = string | string[];

/** Encode one filter value for the URL (arrays join with commas). */
function encode(value: UrlFilterValue): string {
	return Array.isArray(value) ? value.join(",") : value;
}

/** Decode one URL param back into the filter's shape (array-ness follows the default). */
function decode(raw: string, defaultValue: UrlFilterValue): UrlFilterValue {
	return Array.isArray(defaultValue)
		? raw.split(",").filter(Boolean)
		: raw;
}

/** True when a value equals its default (order-insensitive for arrays). */
function isDefault(value: UrlFilterValue, defaultValue: UrlFilterValue): boolean {
	if (Array.isArray(value) && Array.isArray(defaultValue)) {
		if (value.length !== defaultValue.length) return false;
		const d = new Set(defaultValue);
		return value.every((x) => d.has(x));
	}
	return value === defaultValue;
}

/**
 * Two-way sync between a page filter store and the URL search params.
 * `paramNames` optionally renames a filter's param (defaults to the key itself).
 */
export function useFilterUrlSync<F extends Record<string, UrlFilterValue>>(
	store: UseBoundStore<StoreApi<FilterStoreState<F>>>,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
): void {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const filters = store((s) => s.filters);
	const hydrated = useRef(false);

	const paramFor = (key: string): string => paramNames?.[key] ?? key;

	// Mount: hydrate the store from the URL when any mapped param is present.
	// URL wins over persisted session state so shared links show what they say.
	useEffect(() => {
		if (hydrated.current) return;
		hydrated.current = true;
		const fromUrl: Partial<F> = {};
		for (const key of Object.keys(defaults)) {
			const raw = searchParams.get(paramFor(key));
			if (raw !== null) {
				// @ts-expect-error generic Partial<F> can only be written by a keyof-F key (TS2862) and decode returns the broad UrlFilterValue
				fromUrl[key] = decode(raw, defaults[key]);
			}
		}
		if (Object.keys(fromUrl).length > 0) store.getState().patch(fromUrl);
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
			if (isDefault(fresh[key], defaults[key])) params.delete(param);
			else params.set(param, encode(fresh[key]));
		}
		const next = params.toString();
		if (next === searchParams.toString()) return;
		router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the filters only
	}, [filters]);
}
