// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Teams — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// KNOWN DEVIATION, recorded rather than hidden: `getTeams()` takes no arguments and returns no
// facet counts, and the server-action layer is owned by another lane. The org's teams are
// therefore fetched once under `qk.teams(org)` and narrowed here. The facet-count invariant
// still holds (counts below are over the UNFILTERED rows), but the filtering is not yet
// server-side. Follow-up: give `getTeams` a `TeamsQuery` + facets, then delete `filterTeams`.

import type { TeamRow } from "@/app/server/actions/teams";

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

export type TeamSizeBucket = (typeof TEAM_SIZE_OPTIONS)[number]["value"];

/** The size bucket a team falls in. */
export function teamSizeBucket(t: TeamRow): TeamSizeBucket {
	if (t.memberCount === 0) return "empty";
	return t.memberCount <= 5 ? "small" : "large";
}

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

/** Apply the client-side half of the query to the fetched universe. Pure. */
export function filterTeams(
	rows: TeamRow[],
	query: NormalizedTeamsQuery,
): TeamRow[] {
	const q = query.search?.toLowerCase();
	const sizes = query.sizes ? new Set(query.sizes) : null;
	return rows.filter((t) => {
		if (sizes && !sizes.has(teamSizeBucket(t))) return false;
		if (q && !t.name.toLowerCase().includes(q)) return false;
		return true;
	});
}

/** Size-facet counts over the UNFILTERED teams, so no option vanishes as you select it. */
export function teamsFacetCounts(all: TeamRow[]): Record<string, number> {
	const counts: Record<string, number> = { empty: 0, small: 0, large: 0 };
	for (const t of all) {
		const b = teamSizeBucket(t);
		counts[b] = (counts[b] ?? 0) + 1;
	}
	return counts;
}
