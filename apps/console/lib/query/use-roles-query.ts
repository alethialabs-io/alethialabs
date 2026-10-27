// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Roles. #6129 (ADR 0005 D1): both reads are GET procedures the route prefetches —
// `members.roleCatalog` (built-ins, permission catalog, entitlement, manage check) and
// `members.roles` (the custom roles, searched server-side). Live: an `access` hint (a role, its
// permissions or a grant changed) invalidates both.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/settings/members/people-reads";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's custom roles, filtered server-side by `search` (name / description / permission key).
 * Previous results are kept while the next search loads so the rail doesn't flash; with no
 * `search` the input is `{}`, the key the page prefetches.
 */
export function useRolesQuery(search?: string) {
	const q = search?.trim() || undefined;
	return useQuery(
		orpc.members.roles.queryOptions({
			input: q ? { search: q } : {},
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}

/** The Roles page's catalog: built-in roles with grant counts, permissions, entitlement, manage. */
export function useRoleCatalogQuery() {
	return useQuery(
		orpc.members.roleCatalog.queryOptions({ input: undefined, retry: retryUnlessRefused }),
	);
}
