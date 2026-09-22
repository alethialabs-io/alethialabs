// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Access, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the key, the fetch is the SERVER's filtered read, and
// previous rows are kept — and visibly dimmed by the caller — while the next answer loads.
//
// This closes the deviation `components/settings/access/access-filters.ts` recorded against
// itself. The grants list was fetched once under `qk.accessGrants(org, {projectId})` — the only
// axis `listAccessGrants` understood — and search, scope, role and effect were applied in
// memory, so every filtered view shared one cache entry.
//
// The search axis is the one that looked like it could not move, and it already had: a grant's
// SCOPE is a project, runner or cloud-identity NAME that the client resolved through
// `getGrantOptions()`, so "a project's name is not a column the grants query can search" reads
// true and is false. `queryAccessGrantsPage` joins `projects`, `runners`, `cloud_identities`,
// `team` and `user` precisely so the free text reaches the name the Scope column displays, and
// it matches the literal "organization" against `resource_type` for the one scope whose label is
// a constant rather than a row. Nothing about what `search` finds changes here.

import {
	keepPreviousData,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getAccessGrantsPage } from "@/app/server/actions/grants";
import type {
	AccessGrantQuery,
	AccessGrantsPage,
} from "@/lib/queries/access-grants";
import { qk } from "./keys";

/**
 * The org's access grants for `query`, filtered SERVER-SIDE, with the scope, role and effect
 * facets counted over every grant in the same SCOPE.
 *
 * `query.projectId` is the universe selector rather than a filter — on the project-scoped
 * surface both the rows and the facet counts describe that project's grants — which is why it
 * travels inside the same object instead of beside it.
 *
 * @param query the `normalizeAccessQuery()` output; `{}` is the pristine org-wide view
 * @param enabled false without the `customRoles` entitlement, where the server rejects the read
 *   (`requireAccessAdmin`) and the upsell renders instead of the list
 */
export function useAccessGrantsPageQuery(
	query: AccessGrantQuery = {},
	enabled = true,
): UseQueryResult<AccessGrantsPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.accessGrants(org, query),
		queryFn: () => getAccessGrantsPage(query),
		placeholderData: keepPreviousData,
		enabled,
	});
}
