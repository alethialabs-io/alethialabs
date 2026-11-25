// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service tokens list's filter model (the console filter standard, lib/query/README.md →
// "Server-side filters"). Pure and client-safe — no React, no server imports — so the store, the
// route's prefetch and the page's client build the SAME key from the same link.

import { filterStateFromUrl, type ParamReader } from "@/lib/query/filter-url-codec";

/** The store-held filter selections (a type alias — the store factory's Record constraint). */
export type ServiceTokenFilters = {
	search: string;
	/** Token states: `active`, `expired`, `revoked`. */
	status: string[];
};

/** The pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_SERVICE_TOKEN_FILTERS: ServiceTokenFilters = {
	search: "",
	status: [],
};

/** The normalized read input: the whole of the list's key. The cursor is never in it. */
export interface ServiceTokensListQuery {
	search?: string;
	status?: string[];
}

/**
 * Builds the stable read input from the selections: the search trimmed, the statuses sorted, empties
 * dropped — so equal filters produce identical objects and the TanStack key never fragments.
 */
export function normalizeServiceTokensQuery(filters: ServiceTokenFilters): ServiceTokensListQuery {
	const search = filters.search.trim();
	return {
		...(search ? { search } : {}),
		...(filters.status.length ? { status: [...new Set(filters.status)].sort() } : {}),
	};
}

/** The normalized query a link describes — what the route prefetches under. */
export function serviceTokensQueryFromUrl(params: ParamReader): ServiceTokensListQuery {
	return normalizeServiceTokensQuery(filterStateFromUrl(params, DEFAULT_SERVICE_TOKEN_FILTERS));
}
