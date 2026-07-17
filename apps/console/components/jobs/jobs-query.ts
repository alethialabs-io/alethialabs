// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs page's filter model (#578 — the console filter standard). Pure + client-safe
// (no React, no DB): the store shape, defaults, and the normalizer whose output IS the
// TanStack key. The date range deliberately lives OUTSIDE the store: quick-range presets
// are now-relative, so sessionStorage-persisting a resolved range would silently pin
// "last 12 months" to a stale window across visits — the page keeps it as local state
// (the activity feed's precedent) and feeds the resolved ISO bounds into the normalizer.

import type { JobsQuery } from "@/app/server/actions/jobs";

/** The store-held filter selections (a type alias — the factory's Record constraint). */
export type JobsFilters = {
	search: string;
	authors: string[];
	envs: string[];
	projects: string[];
	statuses: string[];
	types: string[];
};

/** The default (empty) selections — the store's initial state and the Reset target. */
export const DEFAULT_JOBS_FILTERS: JobsFilters = {
	search: "",
	authors: [],
	envs: [],
	projects: [],
	statuses: [],
	types: [],
};

/**
 * Builds the stable server query from the selections + the page's resolved date range.
 * Arrays sorted, empties dropped — equal filters produce identical objects, so the
 * TanStack key never fragments. A pinned `projectId` (a project's jobs tab) overrides
 * the Project facet, keeping scoping server-side.
 */
export function normalizeJobsQuery(
	filters: JobsFilters,
	range: { from: string; to: string },
	projectId?: string,
): JobsQuery {
	const sorted = (xs: string[]) => (xs.length ? [...xs].sort() : undefined);
	const projects = projectId ? [projectId] : sorted(filters.projects);
	const search = filters.search.trim();
	return {
		from: range.from,
		to: range.to,
		...(search ? { search } : {}),
		...(sorted(filters.authors) ? { authors: sorted(filters.authors) } : {}),
		...(sorted(filters.envs) ? { envs: sorted(filters.envs) } : {}),
		...(projects ? { projects } : {}),
		...(sorted(filters.statuses) ? { statuses: sorted(filters.statuses) } : {}),
		...(sorted(filters.types) ? { types: sorted(filters.types) } : {}),
	};
}
