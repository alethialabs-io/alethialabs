// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Members — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// KNOWN DEVIATION, recorded rather than hidden: `getMembers()` / `getInvitations()` take no
// arguments and return no facet counts, and the server-action layer is owned by another lane.
// The org's members + pending invitations are fetched once under `qk.members(org)` and narrowed
// here. The facet-count invariant still holds (counts are over the UNFILTERED rows); the
// filtering is not yet server-side. Follow-up: give `getMembers` a query + facets.

/** The unified row the members table renders — a member or a pending invitation. */
export interface MemberRowView {
	/** Unique row id (= key) — satisfies DataTable's `{ id?: string }` constraint. */
	id: string;
	key: string;
	kind: "member" | "invite";
	refId: string;
	name: string;
	meta: string;
	avatar: string;
	role: string;
	teams: string[];
	status: "active" | "pending" | "suspended";
	activity: string;
	isYou: boolean;
}

/** The members list's filter state (a type alias, for the store's `Record` constraint). */
export type MembersFilters = {
	search: string;
	/** `MemberRowView["status"]` values. */
	statuses: string[];
	/** Org role names. */
	roles: string[];
	/** Team names. */
	teams: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_MEMBERS_FILTERS: MembersFilters = {
	search: "",
	statuses: [],
	roles: [],
	teams: [],
};

/** The status facet's options. Finite and known → a literal list, not free strings. */
export const MEMBER_STATUS_OPTIONS = [
	{ value: "active", label: "Active" },
	{ value: "pending", label: "Pending" },
	{ value: "suspended", label: "Suspended" },
] as const;

/**
 * The role facet's options.
 *
 * `owner` is present here but NOT in the row-level role picker: an owner's role cannot be
 * reassigned from this table, yet owners must still be findable. Keeping the two lists separate
 * is the point — conflating them is how "filter by owner" and "demote the owner" became the
 * same array.
 */
export const MEMBER_ROLE_FILTER_OPTIONS = [
	{ value: "owner", label: "Owner" },
	{ value: "admin", label: "Admin" },
	{ value: "operator", label: "Operator" },
	{ value: "viewer", label: "Viewer" },
] as const;

/** The roles a member's inline role picker may assign. Never includes `owner`. */
export const ASSIGNABLE_ROLE_OPTIONS = ["admin", "operator", "viewer"] as const;

/** The stable query object placed in `qk.members`. */
export interface NormalizedMembersQuery {
	search?: string;
	statuses?: string[];
	roles?: string[];
	teams?: string[];
}

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeMembersQuery(
	filters: MembersFilters,
	search: string,
): NormalizedMembersQuery {
	const query: NormalizedMembersQuery = {};
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	const statuses = normalizeList(filters.statuses);
	if (statuses) query.statuses = statuses;
	const roles = normalizeList(filters.roles);
	if (roles) query.roles = roles;
	const teams = normalizeList(filters.teams);
	if (teams) query.teams = teams;
	return query;
}

/** Apply the client-side half of the query to the fetched universe. Pure. */
export function filterMembers(
	rows: MemberRowView[],
	query: NormalizedMembersQuery,
): MemberRowView[] {
	const q = query.search?.toLowerCase();
	const statuses = query.statuses ? new Set(query.statuses) : null;
	const roles = query.roles ? new Set(query.roles) : null;
	const teams = query.teams ? new Set(query.teams) : null;
	return rows.filter((r) => {
		if (statuses && !statuses.has(r.status)) return false;
		if (roles && !roles.has(r.role)) return false;
		if (teams && !r.teams.some((t) => teams.has(t))) return false;
		if (q && !`${r.name} ${r.meta}`.toLowerCase().includes(q)) return false;
		return true;
	});
}

/**
 * Facet counts over the UNFILTERED rows, so no option vanishes as you select it.
 * A member with several teams counts once per team — that is what a team facet means.
 */
export function membersFacetCounts(all: MemberRowView[]): {
	statuses: Record<string, number>;
	roles: Record<string, number>;
	teams: Record<string, number>;
} {
	const statuses: Record<string, number> = {};
	const roles: Record<string, number> = {};
	const teams: Record<string, number> = {};
	for (const r of all) {
		statuses[r.status] = (statuses[r.status] ?? 0) + 1;
		roles[r.role] = (roles[r.role] ?? 0) + 1;
		for (const t of r.teams) teams[t] = (teams[t] ?? 0) + 1;
	}
	return { statuses, roles, teams };
}
