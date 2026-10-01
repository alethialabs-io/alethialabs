// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The URL codec of the console filter standard, shared by its two readers.
//
// `hooks/use-filter-url-sync.ts` reads a pasted link into the page's filter store after mount,
// and a list route's SERVER component reads the same link from `searchParams` to prefetch the
// filtered query before first paint (#4980). Both have to decode a param identically, or the
// server prefetches a key the client never asks for and the page falls back to the unfiltered
// rows as `keepPreviousData` placeholders — the exact defect the prefetch exists to remove. So
// the decode lives here, once, with no React and no `"use client"`: a client-only module
// imported from a server component is a client REFERENCE there, not a callable function.

/** Filter shapes the URL codec can represent. */
export type UrlFilterValue = string | string[];

/** The one method of `URLSearchParams` the decoder needs — also what `useSearchParams()` returns. */
export interface ParamReader {
	get(name: string): string | null;
}

/** Encode one filter value for the URL (arrays join with commas). */
export function encodeFilterValue(value: UrlFilterValue): string {
	return Array.isArray(value) ? value.join(",") : value;
}

/** Decode one URL param back into the filter's shape (array-ness follows the default). */
export function decodeFilterValue(
	raw: string,
	defaultValue: UrlFilterValue,
): UrlFilterValue {
	return Array.isArray(defaultValue) ? raw.split(",").filter(Boolean) : raw;
}

/** True when a value equals its default (order-insensitive for arrays). */
export function isDefaultFilterValue(
	value: UrlFilterValue,
	defaultValue: UrlFilterValue,
): boolean {
	if (Array.isArray(value) && Array.isArray(defaultValue)) {
		if (value.length !== defaultValue.length) return false;
		const d = new Set(defaultValue);
		return value.every((x) => d.has(x));
	}
	return value === defaultValue;
}

/**
 * The filters a URL names: every mapped param that is PRESENT, decoded into its filter's shape.
 * Absent params are absent from the result, so a caller patching a store leaves them as they are.
 *
 * @param params the URL's search params
 * @param defaults the store's defaults — they give the key set and each value's array-ness
 * @param paramNames renames a filter's param (the default is the key itself)
 */
export function filtersFromUrl<F extends Record<string, UrlFilterValue>>(
	params: ParamReader,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
): Partial<F> {
	const fromUrl: Partial<F> = {};
	for (const key of Object.keys(defaults)) {
		const raw = params.get(paramNames?.[key] ?? key);
		if (raw !== null) {
			// @ts-expect-error generic Partial<F> can only be written by a keyof-F key (TS2862) and decode returns the broad UrlFilterValue
			fromUrl[key] = decodeFilterValue(raw, defaults[key]);
		}
	}
	return fromUrl;
}

/**
 * The FULL filter state a URL describes — the defaults with every present param applied. This is
 * what the store holds once `useFilterUrlSync` has run on a fresh tab, so normalizing it gives the
 * key the client will ask for, which is the key a server component must prefetch.
 */
export function filterStateFromUrl<F extends Record<string, UrlFilterValue>>(
	params: ParamReader,
	defaults: F,
	paramNames?: Partial<Record<keyof F, string>>,
): F {
	return { ...defaults, ...filtersFromUrl(params, defaults, paramNames) };
}

/** A Next page's `searchParams` record as a `ParamReader` (a repeated param reads as its first value). */
export function paramReader(
	searchParams: Record<string, string | string[] | undefined>,
): ParamReader {
	return {
		get(name: string): string | null {
			const value = searchParams[name];
			if (value === undefined) return null;
			return Array.isArray(value) ? (value[0] ?? null) : value;
		},
	};
}
