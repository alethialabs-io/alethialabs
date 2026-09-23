// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Members — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters").
//
// The deviation this file used to record — members and invitations fetched once under
// `qk.members(org)` and narrowed HERE, because `getMembers()` took no query — is closed
// (#4890). `getMembersPage(q)` narrows both record kinds in SQL and counts the status, role and
// team facets over the org's unfiltered universe, so `filterMembers` and `membersFacetCounts`
// are gone and this module is the normalize step and nothing else.

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
