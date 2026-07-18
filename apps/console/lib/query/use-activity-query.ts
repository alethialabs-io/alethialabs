"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Activity-log data hook — the console filter standard's fetch half (#578), in its
// cursor-paginated form: the NORMALIZED filter query lives in the key (equal filters hit
// the cache), the id-descending cursor is the infinite query's pageParam (never in the
// key), and keepPreviousData keeps the previous rows on screen (dimmed) while a filter
// change refetches. Replaces the page's raw `useEffect` + `cancelled`-flag chain.

import {
	type InfiniteData,
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
	type ActivityPage,
	getActivityLog,
	type ActivityQuery,
} from "@/app/server/actions/activity";
import { getMembers } from "@/app/server/actions/members";
import { qk } from "@/lib/query/keys";

/** Stable, cache-friendly copy of an ActivityQuery: arrays sorted, empties dropped,
 * cursor excluded (it's the pageParam). Pure — exported for tests. */
export function normalizeActivityQuery(query: ActivityQuery): ActivityQuery {
	const sorted = (xs?: string[]) => (xs && xs.length ? [...xs].sort() : undefined);
	return {
		...(query.from ? { from: query.from } : {}),
		...(query.to ? { to: query.to } : {}),
		...(query.search?.trim() ? { search: query.search.trim() } : {}),
		...(sorted(query.actorIds) ? { actorIds: sorted(query.actorIds) } : {}),
		...(sorted(query.resourceTypes)
			? { resourceTypes: sorted(query.resourceTypes) }
			: {}),
		...(sorted(query.resourceIds) ? { resourceIds: sorted(query.resourceIds) } : {}),
		...(query.decision != null ? { decision: query.decision } : {}),
	};
}

/**
 * Cursor-paginated activity rows for the current filters. `data.pages` accumulate as
 * `fetchNextPage` walks the id-descending cursor; a filter change swaps the key and
 * `keepPreviousData` holds the old rows (dim with `isPlaceholderData`) until page one
 * of the new result lands.
 */
export function useActivityQuery(query: ActivityQuery) {
	const params = useParams<{ org: string }>();
	const org = params.org;
	// Explicit generics pin the page-param type to the cursor (number | null) so `initialPageParam:
	// null` needs no assertion — inference alone would fix it to `null` and clash with getNextPageParam.
	return useInfiniteQuery<
		ActivityPage,
		Error,
		InfiniteData<ActivityPage, number | null>,
		ReturnType<typeof qk.activity>,
		number | null
	>({
		queryKey: qk.activity(org, query),
		queryFn: ({ pageParam }) =>
			getActivityLog(pageParam == null ? query : { ...query, cursor: pageParam }),
		initialPageParam: null,
		getNextPageParam: (last) => last.nextCursor,
		placeholderData: keepPreviousData,
	});
}

/** Org members — filter facets + the humanizer's name resolution. Cached once per org
 * (replaces the page's raw fetch-into-useState effect). */
export function useMembersQuery() {
	const params = useParams<{ org: string }>();
	const org = params.org;
	return useQuery({
		queryKey: qk.members(org),
		queryFn: () => getMembers(),
		staleTime: 60_000,
	});
}
