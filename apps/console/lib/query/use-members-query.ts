// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Members, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the key, the fetch is the SERVER's filtered read, and
// previous rows are kept — and visibly dimmed by the caller — while the next answer loads.
//
// This is the follow-up `components/settings/members/members-filters.ts` recorded against
// itself: members and pending invitations used to be fetched as two unfiltered lists under
// `qk.members(org)` and narrowed in memory, because `getMembers()` took no query.
// `getMembersPage()` (→ `queryMembersPage`, driven by
// tests/lib/queries/filter-standard-facets.test.ts) has taken a `MembersQuery` and returned
// status/role/team facets over the UNFILTERED universe since #2899.
//
// ONE call returns BOTH record kinds on purpose: the table is one list of members and
// invitations, a `statuses: ["pending"]` selection is an invitations-only answer, and a team
// filter excludes invitations entirely (an invitation has no teams). Two queries could not
// express that without the client re-deciding it.

import {
	keepPreviousData,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getMembersPage } from "@/app/server/actions/members";
import type { MembersPage, MembersQuery } from "@/lib/queries/members";
import { qk } from "./keys";

/**
 * The active org's members and pending invitations, filtered SERVER-SIDE, with the status,
 * role and team facets counted over every member and invitation in the org.
 *
 * The query object is ALWAYS handed to the key, `{}` included: `qk.members(org)` is the
 * unfiltered `getMembers()` universe read that the activity log's name resolution shares, and
 * it returns `MemberRow[]`, not a page. Two payload shapes under one key is a cache that
 * serves the wrong one; `["members", org]` still invalidates both.
 *
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function useMembersPageQuery(
	query: MembersQuery = {},
): UseQueryResult<MembersPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.members(org, query),
		queryFn: () => getMembersPage(query),
		placeholderData: keepPreviousData,
	});
}
