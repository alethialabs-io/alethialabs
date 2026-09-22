// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Teams, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the key, the fetch is the SERVER's filtered read, and
// previous rows are kept — and visibly dimmed by the caller — while the next answer loads.
//
// This hook is the follow-up `components/settings/teams/teams-filters.ts` recorded against
// itself: the org's teams used to be fetched once under `qk.teams(org)` and narrowed in
// memory because `getTeams()` took no query. `getTeamsPage()` (→ `queryTeamsPage`, driven by
// tests/lib/queries/filter-standard-facets.test.ts) has taken a `TeamsQuery` and returned
// facets over the UNFILTERED universe since #2899, so the narrowing moves to SQL and the
// facet counts come from the pass that only ever sees the scope predicates.

import {
	keepPreviousData,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getTeamsPage } from "@/app/server/actions/teams";
import type { TeamsPage, TeamsQuery } from "@/lib/queries/teams";
import { qk } from "./keys";

/**
 * The active org's teams, filtered SERVER-SIDE, with the size facet counted over every team
 * in the org.
 *
 * `query` is the `normalizeTeamsQuery()` output and goes into the key verbatim, so two filter
 * states are two cache entries and an unsorted array cannot fragment them. `keepPreviousData`
 * holds the previous rows across a filter change; the caller must dim them off
 * `isPlaceholderData`, because keeping a stale list WITHOUT saying it is stale renders the
 * previous filter's answer as the current one.
 *
 * The query object is ALWAYS handed to the key, `{}` included: `qk.teams(org)` is the
 * unfiltered `getTeams()` universe read that the manage-team dialog and the grant builder
 * share, and it returns `TeamRow[]`, not a page. Two payload shapes under one key is a cache
 * that serves the wrong one; `["teams", org]` still invalidates both.
 *
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function useTeamsPageQuery(
	query: TeamsQuery = {},
): UseQueryResult<TeamsPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.teams(org, query),
		queryFn: () => getTeamsPage(query),
		placeholderData: keepPreviousData,
	});
}
