// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The runners grid, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the key, the fetch is the SERVER's filtered read, and
// previous rows are kept — and visibly dimmed by the caller — while the next answer loads.
//
// Runners was the one surface in the console with no server half AT ALL (#4890): the page
// read the whole universe under `qk.runners(org)` and narrowed it in the component, with the
// predicate living in the filter BAR and the facets tallied beside it. Both moved to
// `lib/queries/runners.ts`, behind `getRunnersPage(query)`.
//
// `useRunnersQuery()` (the unfiltered universe) is NOT replaced — the add-runner dialog reads
// it, and it is what `qk.runners(org)` keys. What moved is the GRID.

import {
	keepPreviousData,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getRunnersPage } from "@/app/server/actions/runners";
import type { RunnersPage, RunnersQuery } from "@/lib/queries/runners";
import type { RunnerWithRelease } from "./resource-fetchers";
import { qk } from "./keys";

/**
 * The org's runners for `query`, filtered SERVER-SIDE, with the cloud, region and version
 * facets counted over every runner the actor can see.
 *
 * Polled on the same 10s cadence `useRunnersQuery()` uses, and for the same reason: a
 * runner's ONLINE/OFFLINE state is heartbeat-driven and changes with nothing on this page
 * happening. `keepPreviousData` holds the grid across both a filter change and a poll; the
 * caller dims off `isPlaceholderData`, which is true for the first and false for the second.
 *
 * @param query the `normalizeRunnersQuery()` output; `{}` is the pristine view
 */
export function useRunnersPageQuery(
	query: RunnersQuery = {},
): UseQueryResult<RunnersPage<RunnerWithRelease>> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.runnersPage(org, query),
		queryFn: () => getRunnersPage(query),
		placeholderData: keepPreviousData,
		refetchInterval: 10_000,
	});
}
