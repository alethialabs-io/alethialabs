// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client- AND server-safe filter plumbing for the runners grid — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React, no store,
// no DB: the page's zustand store (lib/stores/use-runner-filters.ts) holds this shape, and the
// runners ROUTE reads a pasted link into the same shape to prefetch the filtered page (#4980).
// It lived in the store module until the route needed it; a server component cannot import a
// module that builds a sessionStorage-persisted store at load.

import type { RunnersQuery } from "@/lib/queries/runners";
import {
	filterStateFromUrl,
	type ParamReader,
} from "@/lib/query/filter-url-codec";

/** Active filter selections for the runners grid (a type alias, not an interface, so it
 * satisfies the store factory's Record constraint). Empty = "no filter". */
export type RunnerPageFilters = {
	search: string;
	clouds: string[];
	statuses: string[];
	operators: string[];
	regions: string[];
	versions: string[];
};

/** The default (empty) filter set — the store's initial state and the Reset target. */
export const DEFAULT_RUNNER_FILTERS: RunnerPageFilters = {
	search: "",
	clouds: [],
	statuses: [],
	operators: [],
	regions: [],
	versions: [],
};

/** Sorted, deduped copy of a selection — or undefined when nothing is selected. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/**
 * The normalize step (lib/query/README.md, step 4): store state → the stable query object
 * that goes into `qk.runnersPage(org, q)` AND to `getRunnersPage(q)`.
 *
 * The runners page had no such step — the store's raw shape reached neither, because nothing
 * reached the server at all, and the key was the org (#4890). Trimming the search and sorting
 * the selections is what makes two equivalent filter states one cache entry rather than two
 * that never hit.
 *
 * @param filters the store's current state
 * @param search the DEBOUNCED free text — never `filters.search`, which changes per keystroke
 */
export function normalizeRunnersQuery(
	filters: RunnerPageFilters,
	search: string,
): RunnersQuery {
	const query: RunnersQuery = {};
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	const clouds = normalizeList(filters.clouds);
	if (clouds) query.clouds = clouds;
	const statuses = normalizeList(filters.statuses);
	if (statuses) query.statuses = statuses;
	const operators = normalizeList(filters.operators);
	if (operators) query.operators = operators;
	const regions = normalizeList(filters.regions);
	if (regions) query.regions = regions;
	const versions = normalizeList(filters.versions);
	if (versions) query.versions = versions;
	return query;
}

/**
 * The grid's query for a URL — the key the client settles on once `useFilterUrlSync` has read
 * the link and the debounce has caught up, so it is the key the route must prefetch for a pasted
 * filtered link to render filtered rather than as the unfiltered placeholder (#4980, F8).
 */
export function runnersQueryFromUrl(params: ParamReader): RunnersQuery {
	const filters = filterStateFromUrl(params, DEFAULT_RUNNER_FILTERS);
	return normalizeRunnersQuery(filters, filters.search);
}
