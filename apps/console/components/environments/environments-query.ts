// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client- AND server-safe filter plumbing for the Environments list — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React, no store, no
// DB: the page's store (lib/stores/use-environments-filters.ts) holds this shape, and the ROUTE
// reads a link into the same shape to prefetch the read the client will ask for.

import { type ParamReader, filterStateFromUrl } from "@/lib/query/filter-url-codec";
import type { EnvironmentsListQuery } from "@/lib/rpc/procedures/environments";

/** Active filter selections for the environments list (a type alias, not an interface, so it
 * satisfies the store factory's Record constraint). Empty = "no filter". */
export type EnvironmentPageFilters = {
	search: string;
	stages: string[];
	statuses: string[];
};

/** The default (empty) filter set — the store's initial state and the Reset target. */
export const DEFAULT_ENVIRONMENT_FILTERS: EnvironmentPageFilters = {
	search: "",
	stages: [],
	statuses: [],
};

/** Sorted, deduped copy of a selection — or undefined when nothing is selected. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/**
 * The normalize step (lib/query/README.md, step 4): store state → the stable object that is the
 * `environments.page` read's query — and so its infinite key — on the client AND the server. A
 * pristine list's query is `{ project }` alone.
 *
 * `project` is the route's SCOPE (its slug, from the address), never a filter.
 *
 * @param project the project slug the route is under
 * @param filters the store's current state
 * @param search the DEBOUNCED free text — never `filters.search`, which changes per keystroke
 */
export function normalizeEnvironmentsQuery(
	project: string,
	filters: EnvironmentPageFilters,
	search: string,
): EnvironmentsListQuery {
	const input: EnvironmentsListQuery = { project };
	const trimmed = search.trim();
	if (trimmed) input.search = trimmed;
	const stages = normalizeList(filters.stages);
	if (stages) input.stages = stages;
	const statuses = normalizeList(filters.statuses);
	if (statuses) input.statuses = statuses;
	return input;
}

/**
 * The read's input for a URL — the key the client settles on once `useFilterUrlSync` has read the
 * link, so it is the key the route must prefetch for a filtered link to render filtered.
 */
export function environmentsQueryFromUrl(project: string, params: ParamReader): EnvironmentsListQuery {
	const filters = filterStateFromUrl(params, DEFAULT_ENVIRONMENT_FILTERS);
	return normalizeEnvironmentsQuery(project, filters, filters.search);
}
