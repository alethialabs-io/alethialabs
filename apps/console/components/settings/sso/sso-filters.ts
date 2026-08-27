// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · SSO — the console filter standard's "normalize" step
// (lib/query/README.md → "Server-side filters"). `listSsoProviders` already filters
// server-side, so this only has to produce a STABLE query object: arrays sorted and deduped,
// empties dropped, so two equivalent filter states never fragment the cache into two keys.

import type { SsoFilter, SsoProviderRow } from "@/app/server/actions/sso";

/** The SSO list's filter state (a type alias, for the store's `Record` constraint). */
export type SsoFilters = {
	search: string;
	types: string[];
	statuses: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_SSO_FILTERS: SsoFilters = {
	search: "",
	types: [],
	statuses: [],
};

/** The protocol facet's options. Mirrors `SsoProviderType`. */
export const SSO_TYPE_OPTIONS = [
	{ value: "oidc", label: "OIDC" },
	{ value: "saml", label: "SAML" },
	{ value: "unknown", label: "Misconfigured" },
] as const;

/** The domain-verification facet's options. Mirrors `SsoFilter["statuses"]`. */
export const SSO_STATUS_OPTIONS = [
	{ value: "verified", label: "Verified" },
	{ value: "pending", label: "Pending" },
] as const;

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList<T extends string>(
	values: string[],
	isMember: (v: string) => v is T,
): T[] | undefined {
	const kept = [...new Set(values)].filter(isMember).sort();
	return kept.length ? kept : undefined;
}

/** True for a value the action's `types` union accepts (the server re-validates regardless). */
function isSsoType(v: string): v is NonNullable<SsoFilter["types"]>[number] {
	return v === "oidc" || v === "saml" || v === "unknown";
}

/** True for a value the action's `statuses` union accepts. */
function isSsoStatus(v: string): v is NonNullable<SsoFilter["statuses"]>[number] {
	return v === "verified" || v === "pending";
}

/**
 * Normalize filter state into the stable query object placed in `qk.ssoProviders` and sent to
 * `listSsoProviders`. The `search` argument is the DEBOUNCED text — passing the raw input
 * would put a key in the cache for every keystroke.
 */
export function normalizeSsoQuery(
	filters: SsoFilters,
	search: string,
): SsoFilter {
	const query: SsoFilter = {};
	const trimmed = search.trim();
	if (trimmed) query.search = trimmed;
	const types = normalizeList(filters.types, isSsoType);
	if (types) query.types = types;
	const statuses = normalizeList(filters.statuses, isSsoStatus);
	if (statuses) query.statuses = statuses;
	return query;
}

/**
 * Facet counts over the UNFILTERED provider universe.
 *
 * The standard requires option counts computed over everything, not over the current result —
 * an option that vanishes the moment you select it makes the facet unusable. `listSsoProviders`
 * does not return facets, so the unfiltered list is fetched under the base key (the same one the
 * page prefetches) and counted here.
 */
export function ssoFacetCounts(all: SsoProviderRow[]): {
	types: Record<string, number>;
	statuses: Record<string, number>;
} {
	const types: Record<string, number> = {};
	const statuses: Record<string, number> = { verified: 0, pending: 0 };
	for (const p of all) {
		types[p.type] = (types[p.type] ?? 0) + 1;
		const key = p.domainVerified ? "verified" : "pending";
		statuses[key] = (statuses[key] ?? 0) + 1;
	}
	return { types, statuses };
}
