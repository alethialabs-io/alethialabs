// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's filter store — the console filter standard (#578):
// createFilterStore + URL sync + debounced search. See lib/query/README.md
// → "Server-side filters (the standard)"; evidence is the reference.

import type { RunnersQuery } from "@/lib/queries/runners";
import { createFilterStore } from "@/lib/stores/create-filter-store";

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

/** sessionStorage-persisted, URL-synced by the page via useFilterUrlSync. */
export const useRunnerFilters = createFilterStore<RunnerPageFilters>({
	name: "runner-filters",
	defaults: DEFAULT_RUNNER_FILTERS,
	version: 1,
});

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
