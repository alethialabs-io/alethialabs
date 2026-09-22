// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Teams — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// The deviation this file used to record — the org's teams fetched once under `qk.teams(org)`
// and narrowed HERE, because `getTeams()` took no query — is closed (#4890). `getTeamsPage(q)`
// narrows in SQL and counts the size facet over the org's unfiltered teams, so `filterTeams`
// and `teamsFacetCounts` are gone and this module is the normalize step and nothing else.

/** The teams list's filter state (a type alias, for the store's `Record` constraint). */
export type TeamsFilters = {
	search: string;
	/** Team size buckets — see {@link TEAM_SIZE_OPTIONS}. */
	sizes: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_TEAMS_FILTERS: TeamsFilters = {
	search: "",
	sizes: [],
};

/** The size facet's buckets. Finite and known, so they are a literal union, not free strings. */
export const TEAM_SIZE_OPTIONS = [
	{ value: "empty", label: "No members" },
	{ value: "small", label: "1–5 members" },
	{ value: "large", label: "6+ members" },
] as const;

/** The stable query object placed in `qk.teams`. */
export interface NormalizedTeamsQuery {
	search?: string;
	sizes?: string[];
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeTeamsQuery(
	filters: TeamsFilters,
	search: string,
): NormalizedTeamsQuery {
	const query: NormalizedTeamsQuery = {};
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	if (filters.sizes.length) query.sizes = [...new Set(filters.sizes)].sort();
	return query;
}
