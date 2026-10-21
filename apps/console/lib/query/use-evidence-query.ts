// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The Evidence page's data hook — the filter standard's fetch step: filter store → debounced
// search → normalized query object → the `evidence.page` GET procedure, keyed by that object.
// keepPreviousData keeps the previous view rendered (dimmed via isPlaceholderData) while a filter
// change refetches.
//
// #6126 (ADR 0005 D1): the read is a GET procedure, no longer a server-action POST. The route
// prefetches it for the LINK's filters, so until `useFilterUrlSync` has read the link into the store
// (`urlRead`), this hook asks for exactly that — the link's filters, decoded the way the route
// decodes them. The first paint therefore reads the hydrated entry: no fetch on mount, and no blank
// frame while the store still holds its defaults or the session's last filters.
//
// Only TYPED search is debounced. A search the link carried reaches the store in
// `useFilterUrlSync`'s mount effect, and a plain debounce held the store's default `""` for another
// 300ms after that (#5861) — `{ urlRead }` lets it through at once.
//
// No poll: a verdict, a drift or security scan, a waiver, an environment change is a hint on the
// org's change stream, which invalidates this key (lib/query/topics.ts).

import { ORPCError } from "@orpc/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import {
	filtersFromSearchParams,
	normalizeEvidenceQuery,
} from "@/components/evidence/evidence-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { orpc } from "@/lib/rpc/client";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";

const SEARCH_DEBOUNCE = 300;

/**
 * One retry for a failure, none for a typed refusal (FORBIDDEN, …): a refusal answers the same the
 * second time, so retrying it only delays the page's refusal render.
 */
function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return !(error instanceof ORPCError && error.defined) && failureCount < 1;
}

/**
 * The evidence roll-up for the current filter state (server-side filtering).
 *
 * `urlRead` is what the page's `useFilterUrlSync(useEvidenceFilters, …)` returned. It is required,
 * not optional, because forgetting it is silent: the hook still works, one debounce late, with the
 * unfiltered rows on screen in between.
 */
export function useEvidenceQuery(urlRead: boolean) {
	const searchParams = useSearchParams();
	const filters = useEvidenceFilters((s) => s.filters);
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE, { urlRead });
	const query = useMemo(
		() =>
			urlRead
				? normalizeEvidenceQuery({ ...filters, search })
				: normalizeEvidenceQuery(
						filtersFromSearchParams(Object.fromEntries(searchParams.entries())),
					),
		[urlRead, filters, search, searchParams],
	);

	return useQuery(
		orpc.evidence.page.queryOptions({
			input: query,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}
