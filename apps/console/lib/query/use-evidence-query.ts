// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The Evidence page's data hook — the filter standard's fetch step: filter store →
// debounced search → normalized query object → filter-in-key TanStack query →
// getOrgEvidence. keepPreviousData keeps the previous view rendered (dimmed via
// isPlaceholderData) while a filter change refetches.
//
// Only TYPED search is debounced. A search the link carried (`~/evidence?search=foo`) reaches
// the store in `useFilterUrlSync`'s mount effect, and a plain debounce held the store's default
// `""` for another 300ms after that: the page asked for — and, under keepPreviousData, kept
// showing — every environment in the org before the filtered rows arrived (#5861).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { getOrgEvidence } from "@/app/server/actions/evidence";
import { normalizeEvidenceQuery } from "@/components/evidence/evidence-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { qk } from "@/lib/query/keys";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";

const SEARCH_DEBOUNCE = 300;

/**
 * The org evidence roll-up for the current filter state (server-side filtering).
 *
 * `urlRead` is what the page's `useFilterUrlSync(useEvidenceFilters, …)` returned. Nothing is
 * fetched before it is true, and from the render it turns true the link's search is in the key at
 * once. It is required, not optional, because forgetting it is silent: the hook still works, one
 * debounce late, with the unfiltered rows on screen in between.
 */
export function useEvidenceQuery(urlRead: boolean) {
	const { org } = useParams<{ org: string }>();
	const filters = useEvidenceFilters((s) => s.filters);
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE, { urlRead });
	const query = useMemo(
		() => normalizeEvidenceQuery({ ...filters, search }),
		[filters, search],
	);

	return useQuery({
		queryKey: qk.evidence(org, query),
		queryFn: () => getOrgEvidence(query),
		placeholderData: keepPreviousData,
		// Until the link is read the store holds its defaults (or the session's last filters), not
		// what the URL says — a key the route did not prefetch (it prefetches the link's own).
		// Fetching it would be a read whose answer is replaced one render later.
		enabled: urlRead,
	});
}
