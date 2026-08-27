// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Access — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// KNOWN DEVIATION from step 5/6 of the standard, recorded rather than hidden:
// `listAccessGrants(projectId?)` takes no search / scope / role filter and returns no facet
// counts, and the server-action layer is owned by another lane. So the ORG-SCOPED universe is
// fetched once under `qk.accessGrants(org, {projectId})` — the only axis the action understands
// — and the remaining axes are applied here, over that universe. The facet-count invariant
// ("options must not disappear as you select them") still holds, because the counts below are
// computed over the UNFILTERED rows. What is not yet true is that filtering is server-side; a
// grants list is bounded per org, so this is correct today and wrong at scale. Follow-up: give
// `listAccessGrants` an `AccessGrantQuery` + facets, then delete `filterGrants`.

import type { AccessGrantRow } from "@/app/server/actions/grants";

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

/** The facet value a grant's role column falls under: its role name, or its permission key. */
export function grantRoleKey(g: AccessGrantRow): string {
	return g.roleName ?? (g.permissionKey ? `permission:${g.permissionKey}` : "—");
}

/** The label for a role facet value produced by {@link grantRoleKey}. */
export function grantRoleLabel(key: string): string {
	return key.startsWith("permission:") ? key.slice("permission:".length) : key;
}

/**
 * The stable query object placed in `qk.accessGrants`. Only `projectId` reaches the server
 * today; the rest of the filters are in the key so a future server-side implementation can
 * start honouring them without any call site changing.
 */
export interface NormalizedAccessQuery {
	projectId?: string;
	search?: string;
	scopes?: string[];
	roles?: string[];
	effects?: string[];
}

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
 * Apply the client-side half of the query to the fetched universe. Pure, so the predicate is
 * testable without a component. `scopeLabel` resolves a grant's scoped resource to its display
 * name so the search matches what the row actually shows.
 */
export function filterGrants(
	rows: AccessGrantRow[],
	query: NormalizedAccessQuery,
	scopeLabel: (g: AccessGrantRow) => string,
): AccessGrantRow[] {
	const q = query.search?.toLowerCase();
	const scopes = query.scopes ? new Set(query.scopes) : null;
	const roles = query.roles ? new Set(query.roles) : null;
	const effects = query.effects ? new Set(query.effects) : null;
	return rows.filter((g) => {
		if (scopes && !scopes.has(g.resourceType)) return false;
		if (roles && !roles.has(grantRoleKey(g))) return false;
		if (effects && !effects.has(g.effect)) return false;
		if (q && !`${g.principalLabel} ${scopeLabel(g)}`.toLowerCase().includes(q))
			return false;
		return true;
	});
}

/** One facet's option counts over the unfiltered universe. */
function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) {
		const k = key(row);
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
}

/**
 * Facet counts over the UNFILTERED grants, so no option disappears as you select it — the
 * invariant step 6 of the standard exists to protect.
 */
export function accessFacetCounts(all: AccessGrantRow[]): {
	scopes: Record<string, number>;
	roles: Record<string, number>;
	effects: Record<string, number>;
} {
	return {
		scopes: countBy(all, (g) => g.resourceType),
		roles: countBy(all, grantRoleKey),
		effects: countBy(all, (g) => g.effect),
	};
}
