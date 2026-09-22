// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Access — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// The deviation this file used to record — the org-scoped universe fetched once under
// `qk.accessGrants(org, {projectId})` and the remaining axes applied HERE, because
// `listAccessGrants(projectId?)` took no other filter — is closed (#4890).
// `getAccessGrantsPage(q)` narrows in SQL and counts the scope/role/effect facets over the
// UNFILTERED grants of the same scope, so `filterGrants` and `accessFacetCounts` are gone and
// this module is the normalize step, the display vocabulary, and nothing else.

import type { AccessGrantQuery } from "@/lib/queries/access-grants";
import type { FacetOption } from "@/lib/queries/facets";

/** The Access grants list's filter state (a type alias, for the store's `Record` constraint). */
export type AccessFilters = {
	search: string;
	/** `resourceType` values: org | project | runner | cloud_identity. */
	scopes: string[];
	/** Role names, or the `permission:<key>` pseudo-role for a direct permission grant. */
	roles: string[];
	/** "allow" | "deny". */
	effects: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_ACCESS_FILTERS: AccessFilters = {
	search: "",
	scopes: [],
	roles: [],
	effects: [],
};

/** Human labels for a grant's scope level. */
export const SCOPE_LEVEL: Record<string, string> = {
	org: "Org-wide",
	project: "Project",
	runner: "Runner",
	cloud_identity: "Cloud identity",
};

/** The effect facet's options. */
export const EFFECT_OPTIONS = [
	{ value: "allow", label: "Allow" },
	{ value: "deny", label: "Deny" },
] as const;

/** Qualitative inheritance reach for a scope (exact counts are a backend gap). */
export function reachLabel(resourceType: string): string {
	switch (resourceType) {
		case "org":
			return "All Projects";
		case "project":
			return "This Project";
		case "runner":
			return "This runner";
		case "cloud_identity":
			return "This identity";
		default:
			return "—";
	}
}

/** The label for a role facet value produced by {@link grantRoleKey}. */
export function grantRoleLabel(key: string): string {
	return key.startsWith("permission:") ? key.slice("permission:".length) : key;
}

/**
 * The stable query object placed in `qk.accessGrants` AND handed to `getAccessGrantsPage()`.
 *
 * An ALIAS of the builder's own query type rather than a second declaration of the same five
 * fields: the key and the server read take the identical object, and two shapes that must agree
 * are a pair that can stop agreeing.
 */
export type NormalizedAccessQuery = AccessGrantQuery;

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeAccessQuery(
	filters: AccessFilters,
	search: string,
	projectId?: string,
): NormalizedAccessQuery {
	const query: NormalizedAccessQuery = {};
	if (projectId) query.projectId = projectId;
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	const scopes = normalizeList(filters.scopes);
	if (scopes) query.scopes = scopes;
	const roles = normalizeList(filters.roles);
	if (roles) query.roles = roles;
	const effects = normalizeList(filters.effects);
	if (effects) query.effects = effects;
	return query;
}

/**
 * A facet's options as the `Record<value, count>` the bars read.
 *
 * The bars index by value (and `Object.keys` the role facet, whose values are open-ended), so
 * the server's ordered option list is reshaped here rather than at four call sites.
 */
export function facetCounts(options: FacetOption[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const o of options) counts[o.value] = o.count;
	return counts;
}
