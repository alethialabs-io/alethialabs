"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Activity-log data hook — the console filter standard's fetch half (#578), in its cursor-paginated
// form, over the `activity.page` GET procedure (#6129, ADR 0005 D1): the NORMALIZED filter query is
// the input (equal filters hit the cache), the id-descending cursor is the infinite query's
// pageParam (never in the key), and keepPreviousData keeps the previous rows on screen (dimmed)
// while a filter change refetches. The route prefetches the first page under the same key
// (`prefetchActivityFeed`), so the feed paints with rows. Live: an `activity` hint (a row was
// recorded) invalidates it (lib/query/topics.ts).

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ActivityQuery } from "@/app/server/actions/activity";
import { normalizeActivityQuery } from "@/lib/query/activity-query";
import { orpc } from "@/lib/rpc/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";

/**
 * Cursor-paginated activity rows for the current filters. `data.pages` accumulate as
 * `fetchNextPage` walks the id-descending cursor; a filter change swaps the key and
 * `keepPreviousData` holds the old rows (dim with `isPlaceholderData`) until page one
 * of the new result lands. A refusal (no `view_activity`) is never retried.
 */
export function useActivityQuery(query: ActivityQuery) {
	// Normalized HERE, at the key: the step is idempotent, so a caller that already normalized (the
	// feed, the route's prefetch) gets the identical key, and one that did not cannot fragment the cache.
	const input = normalizeActivityQuery(query);
	return useInfiniteQuery(
		orpc.activity.page.infiniteOptions({
			input: (cursor: number | null) => (cursor == null ? input : { ...input, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}

/**
 * Org members — filter facets + the humanizer's name resolution, and the jobs list's authors.
 * The `members.list` GET procedure (#6129, ADR 0005 D1), cached once per org; a `members` hint
 * invalidates it (lib/query/topics.ts).
 */
export function useMembersQuery() {
	return useQuery(orpc.members.list.queryOptions({ input: undefined, staleTime: 60_000 }));
}
