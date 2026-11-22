// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters list's filter store — the console filter standard: createFilterStore + URL sync +
// debounced search. See lib/query/README.md → "Server-side filters (the standard)".

import { type ClusterPageFilters, DEFAULT_CLUSTER_FILTERS } from "@/components/clusters/clusters-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/**
 * One store for `/{org}/~/clusters` and every `/{org}/{project}/clusters`: the page's pathname is
 * its scope key (`useFilterUrlSync` enters it), so a selection made on one never shows on another.
 * It remembers nothing; the URL is its memory. The filter shape, its defaults and the normalize
 * step live in components/clusters/clusters-query.ts.
 */
export const useClustersFilters = createFilterStore<ClusterPageFilters>({
	name: "clusters-filters",
	defaults: DEFAULT_CLUSTER_FILTERS,
	version: 1,
});
