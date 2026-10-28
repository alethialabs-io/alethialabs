// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Teams, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the input (and so the key), the fetch is the SERVER's
// filtered read, and previous rows are kept — and visibly dimmed by the caller — while the next
// answer loads.
//
// #6129 (ADR 0005 D1): the read is the `members.teams` GET procedure; the route prefetches the same
// key. Live: a `members` hint (a team or a team membership changed) invalidates it.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TeamsQuery } from "@/lib/queries/teams";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's teams, filtered SERVER-SIDE, with the size facet counted over every team in the org.
 * `keepPreviousData` holds the previous rows across a filter change; the caller must dim them off
 * `isPlaceholderData`, because keeping a stale list WITHOUT saying it is stale renders the
 * previous filter's answer as the current one.
 *
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function useTeamsPageQuery(query: TeamsQuery = {}) {
	return useQuery(
		orpc.members.teams.queryOptions({ input: query, placeholderData: keepPreviousData }),
	);
}
