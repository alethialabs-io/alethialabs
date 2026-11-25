// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approvals list's filter model (the console filter standard, lib/query/README.md). Pure and
// client-safe: the store shape, the defaults, and the normalizer whose output IS the list's key.
//
// THE DEFAULT VIEW IS "WAITING" (spec §1.3). `status` defaults to `["pending"]`, so a bare
// `/{org}/~/approvals` opens on exactly the requests a person has to decide, and the Status facet
// shows it as a real, clearable selection. Clearing it is a choice the link carries (`?status=`,
// empty), so "every request" is shareable too. Because the default is a selection, "Reset" returns
// to Waiting, and "Clear filters" (the no-match state's way back) clears the status as well.

import { filterStateFromUrl, type ParamReader } from "@/lib/query/filter-url-codec";

/** The store-held filter selections (a type alias — the factory's Record constraint). */
export type ApprovalsFilters = {
	search: string;
	/** Effective statuses (`APPROVAL_STATUSES`); the default is Waiting. */
	status: string[];
	/** `deploy` / `destroy`. */
	operation: string[];
	/** Requested through: credential kinds. */
	credential: string[];
	/** Environment ids. */
	environment: string[];
};

/** The view a bare link opens on: Waiting requests, nothing else selected. */
export const DEFAULT_APPROVALS_FILTERS: ApprovalsFilters = {
	search: "",
	status: ["pending"],
	operation: [],
	credential: [],
	environment: [],
};

/** Every filter cleared, the status included: the no-match state's "Clear filters". */
export const CLEARED_APPROVALS_FILTERS: ApprovalsFilters = {
	search: "",
	status: [],
	operation: [],
	credential: [],
	environment: [],
};

/** The list's normalized read input: the whole of its key (the cursor is the page param, not here). */
export interface ApprovalsListQuery {
	search?: string;
	status?: string[];
	operation?: string[];
	credential?: string[];
	environment?: string[];
}

/** A sorted copy, or undefined for an empty selection, so equal selections build equal keys. */
function sorted(values: readonly string[]): string[] | undefined {
	return values.length ? [...values].sort() : undefined;
}

/**
 * Builds the stable read input from the selections: arrays sorted, empties dropped, the search
 * trimmed. The route's server component and the browser build the SAME object from the same link.
 */
export function normalizeApprovalsQuery(filters: ApprovalsFilters): ApprovalsListQuery {
	const search = filters.search.trim();
	const query: ApprovalsListQuery = {};
	if (search) query.search = search;
	const status = sorted(filters.status);
	if (status) query.status = status;
	const operation = sorted(filters.operation);
	if (operation) query.operation = operation;
	const credential = sorted(filters.credential);
	if (credential) query.credential = credential;
	const environment = sorted(filters.environment);
	if (environment) query.environment = environment;
	return query;
}

/** The normalized query a link describes — what the route prefetches and the client settles on. */
export function approvalsQueryFromUrl(params: ParamReader): ApprovalsListQuery {
	return normalizeApprovalsQuery(filterStateFromUrl(params, DEFAULT_APPROVALS_FILTERS));
}

/** True when the selections are exactly the default view (Waiting, nothing else). */
export function isDefaultApprovalsView(filters: ApprovalsFilters): boolean {
	return (
		filters.search.trim() === "" &&
		filters.status.length === 1 &&
		filters.status[0] === "pending" &&
		filters.operation.length === 0 &&
		filters.credential.length === 0 &&
		filters.environment.length === 0
	);
}
