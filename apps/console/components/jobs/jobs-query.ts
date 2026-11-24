// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs page's filter model (#578 — the console filter standard). Pure + client-safe
// (no React, no DB): the store shape, defaults, and the normalizer whose output IS the
// TanStack key.
//
// THE DATE RANGE IS ONE FILTER VALUE (`range`, lib/query/range-filter.ts), so it travels in the
// link with every other filter (`?range=30d`) and "Reset" clears it with them. It used to be
// component state beside the store: a filtered link opened on the default window whatever its
// sender had picked, and the bar's reset and the empty state's reset disagreed about it. A preset
// is stored as its id and resolved by the READ, so a link to "last 30 days" stays relative.

import { parseRangeFilter } from "@/lib/query/range-filter";
import { JOBS_DEFAULT_PRESET, type JobsPageInput, type JobsRange, jobsPageInputFrom } from "@/lib/rpc/inputs/jobs";
import { type DateRange, presetRange } from "@repo/ui/range";

/**
 * The jobs list's normalized query: the filters, the range, and the project whose list it is. It is
 * the WHOLE of the list's query key. The page size and the cursor are not in it: `useKeysetList`
 * sends the cursor as the infinite query's page param, and the server's default page size applies.
 */
export type JobsListQuery = JobsPageInput & { projectId?: string };

/** The store-held filter selections (a type alias — the factory's Record constraint). */
export type JobsFilters = {
	search: string;
	/** The time window: "" (the default window), a preset id, or `<from>/<to>`. */
	range: string;
	authors: string[];
	envs: string[];
	projects: string[];
	statuses: string[];
	types: string[];
};

/** The default (empty) selections — the store's initial state and the Reset target. */
export const DEFAULT_JOBS_FILTERS: JobsFilters = {
	search: "",
	range: "",
	authors: [],
	envs: [],
	projects: [],
	statuses: [],
	types: [],
};

/** What the read is asked for a `range` filter value: the preset to resolve, or explicit bounds. */
export function jobsRangeOf(range: string): JobsRange {
	const choice = parseRangeFilter(range);
	if (choice.kind === "preset") return { preset: choice.preset };
	if (choice.kind === "window") return { from: choice.from, to: choice.to };
	return { preset: JOBS_DEFAULT_PRESET };
}

/**
 * The window the range pickers show for a `range` filter value. `now` is the instant a preset is
 * shown against; pass one resolved once (at mount), or the pickers' value moves on every render.
 */
export function jobsRangeWindow(range: string, now: Date): DateRange {
	const choice = parseRangeFilter(range);
	if (choice.kind === "window") return { from: new Date(choice.from), to: new Date(choice.to) };
	return presetRange(choice.kind === "preset" ? choice.preset : JOBS_DEFAULT_PRESET, now);
}

/**
 * Builds the stable read input from the selections. Arrays sorted, empties dropped — equal
 * filters produce identical objects, so the TanStack key never fragments, and the route's server
 * component and the browser build the SAME key from the same link.
 *
 * `projectId` is the SCOPE of a project's jobs list, not a filter (lib/query/README.md, "Scope is
 * a predicate, never a filter"): it travels as its own field, the read applies it to the facet
 * counts as well as the rows, and the Project facet's selection is dropped — on a project's list
 * that facet is not offered.
 */
export function normalizeJobsQuery(filters: JobsFilters, projectId?: string): JobsListQuery {
	const sorted = (xs: string[]) => (xs.length ? [...xs].sort() : undefined);
	const search = filters.search.trim();
	const input = jobsPageInputFrom(
		{
			...(search ? { search } : {}),
			authors: sorted(filters.authors),
			envs: sorted(filters.envs),
			projects: projectId ? undefined : sorted(filters.projects),
			statuses: sorted(filters.statuses),
			types: sorted(filters.types),
		},
		jobsRangeOf(filters.range),
	);
	return projectId ? { ...input, projectId } : input;
}
