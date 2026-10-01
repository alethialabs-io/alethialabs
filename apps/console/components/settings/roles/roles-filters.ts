// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Roles — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters"). `listRoles(search)` filters custom roles
// server-side; the four built-ins arrive with the page bootstrap and are narrowed here, which
// is why `filterBuiltins` exists at all.

import type { RoleRow } from "@/app/server/actions/roles";

/** The roles rail's filter state (a type alias, for the store's `Record` constraint). */
export type RolesFilters = {
	search: string;
	/** Which kinds of role the rail shows — see {@link ROLE_KIND_OPTIONS}. */
	kinds: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_ROLES_FILTERS: RolesFilters = {
	search: "",
	kinds: [],
};

/** The kind facet's options. */
export const ROLE_KIND_OPTIONS = [
	{ value: "builtin", label: "Built-in" },
	{ value: "custom", label: "Custom" },
] as const;

/** The stable query object placed in `qk.roles`. */
export interface NormalizedRolesQuery {
	search?: string;
	kinds?: string[];
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeRolesQuery(
	filters: RolesFilters,
	search: string,
): NormalizedRolesQuery {
	const query: NormalizedRolesQuery = {};
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	if (filters.kinds.length) query.kinds = [...new Set(filters.kinds)].sort();
	return query;
}

/** True when the rail should show roles of this kind (an empty selection shows both). */
export function showsKind(
	query: NormalizedRolesQuery,
	kind: "builtin" | "custom",
): boolean {
	return !query.kinds || query.kinds.includes(kind);
}

/**
 * Narrow the built-in roles client-side. There are four of them and they ship with the page
 * bootstrap rather than the query, so a server round-trip would be pure ceremony — but the
 * predicate still lives here, pure and testable, rather than inline in the component.
 */
export function filterBuiltins(
	builtin: RoleRow[],
	query: NormalizedRolesQuery,
): RoleRow[] {
	if (!showsKind(query, "builtin")) return [];
	const q = query.search?.toLowerCase();
	if (!q) return builtin;
	return builtin.filter(
		(r) =>
			r.name.toLowerCase().includes(q) ||
			(r.description?.toLowerCase().includes(q) ?? false),
	);
}

/** What {@link hasNoMatches} decides from — counts of the rows each bucket kept. */
export interface NoMatchesInput {
	/** Active filter count (search + facets); zero means the rail is unfiltered. */
	activeFilters: number;
	builtinCount: number;
	customCount: number;
	/**
	 * The custom-role query has answered the CURRENT search: not pending, and not showing the
	 * previous search's placeholder data. An unsettled count is not evidence of "no match".
	 */
	settled: boolean;
}

/** True when the zero-result empty state should replace the master-detail. */
export function hasNoMatches(input: NoMatchesInput): boolean {
	return (
		input.settled &&
		input.activeFilters > 0 &&
		input.builtinCount + input.customCount === 0
	);
}

/**
 * The zero-result empty state's description. `total` is the role UNIVERSE (every built-in plus
 * every custom role, unsearched) — never the search result, which is what the state is saying
 * is empty. Unknown until the unsearched list loads, and then the number is left out.
 */
export function noMatchesDescription(total: number | undefined): string {
	if (total === undefined) return "No roles match these filters.";
	return `None of the ${total} ${total === 1 ? "role matches" : "roles match"} these filters.`;
}
