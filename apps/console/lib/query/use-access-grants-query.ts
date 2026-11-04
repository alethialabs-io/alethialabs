// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Access, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the input (and so the key), the fetch is the SERVER's
// filtered read, and previous rows are kept — and visibly dimmed by the caller — while the next
// answer loads.
//
// #6129 (ADR 0005 D1): the grants page and the builder's options are the `members.grants` and
// `members.grantOptions` GET procedures; the org route prefetches both. Live: an `access` hint (a
// grant or a role changed) invalidates them.
//
// The search axis reaches a grant's SCOPE by name: `queryAccessGrantsPage` joins `projects`,
// `runners`, `cloud_identities`, `team` and `user`, so the free text matches the name the Scope
// column displays, and the literal "organization" matches the org-wide scope.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/settings/members/people-reads";
import type { AccessGrantQuery } from "@/lib/queries/access-grants";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's access grants for `query`, filtered SERVER-SIDE, with the scope, role and effect
 * facets counted over every grant in the same SCOPE. `query.projectId` is the universe selector
 * (the project-scoped surface), which is why it travels inside the same object.
 *
 * @param query the `normalizeAccessQuery()` output; `{}` is the pristine org-wide view
 * @param enabled false without the `customRoles` entitlement, where the upsell renders instead
 */
export function useAccessGrantsPageQuery(query: AccessGrantQuery = {}, enabled = true) {
	return useQuery(
		orpc.members.grants.queryOptions({
			input: query,
			placeholderData: keepPreviousData,
			enabled,
			retry: retryUnlessRefused,
		}),
	);
}

/** The grant builder's principals, roles, permissions and scopes. */
export function useGrantOptionsQuery(enabled = true) {
	return useQuery(
		orpc.members.grantOptions.queryOptions({ input: undefined, enabled, retry: retryUnlessRefused }),
	);
}
