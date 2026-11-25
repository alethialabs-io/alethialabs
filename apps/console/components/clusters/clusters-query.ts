// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client- AND server-safe filter plumbing for the clusters list — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React, no store, no
// DB: the page's store (lib/stores/use-clusters-filters.ts) holds this shape, and both clusters
// ROUTES read a link into the same shape to prefetch the page the client will ask for.

import { type ParamReader, filterStateFromUrl } from "@/lib/query/filter-url-codec";
import type { ClustersListQuery } from "@/lib/rpc/procedures/clusters";

/** Active filter selections for the clusters list (a type alias, not an interface, so it
 * satisfies the store factory's Record constraint). Empty = "no filter". */
export type ClusterPageFilters = {
	search: string;
	clouds: string[];
	statuses: string[];
	regions: string[];
};

/** The default (empty) filter set — the store's initial state and the Reset target. */
export const DEFAULT_CLUSTER_FILTERS: ClusterPageFilters = {
	search: "",
	clouds: [],
	statuses: [],
	regions: [],
};

/** Sorted, deduped copy of a selection — or undefined when nothing is selected. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/**
 * The normalize step (lib/query/README.md, step 4): store state → the stable object that is the
 * `clusters.page` read's input — and so its query key — on the client AND the server. Trimming the
 * search and sorting the selections is what makes two equivalent filter states one cache entry.
 *
 * `projectId` is the route's SCOPE, not a filter: it comes from the address, is never in the store
 * or the query string, and is part of the input so two scopes never share a cache entry.
 *
 * @param filters the store's current state
 * @param search the DEBOUNCED free text — never `filters.search`, which changes per keystroke
 * @param projectId the project a project route lists; undefined on the org route
 */
export function normalizeClustersQuery(
	filters: ClusterPageFilters,
	search: string,
	projectId?: string,
): ClustersListQuery {
	const query: ClustersListQuery = {};
	if (projectId) query.projectId = projectId;
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	const clouds = normalizeList(filters.clouds);
	if (clouds) query.clouds = clouds;
	const statuses = normalizeList(filters.statuses);
	if (statuses) query.statuses = statuses;
	const regions = normalizeList(filters.regions);
	if (regions) query.regions = regions;
	return query;
}

/**
 * The list's query for a URL — the key the client settles on once `useFilterUrlSync` has read the
 * link, so it is the key a route must prefetch for a filtered link to render filtered.
 */
export function clustersQueryFromUrl(params: ParamReader, projectId?: string): ClustersListQuery {
	const filters = filterStateFromUrl(params, DEFAULT_CLUSTER_FILTERS);
	return normalizeClustersQuery(filters, filters.search, projectId);
}
