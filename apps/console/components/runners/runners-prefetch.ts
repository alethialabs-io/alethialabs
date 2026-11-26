// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { Query, QueryClient } from "@tanstack/react-query";
import type { RunnersQuery } from "@/lib/queries/runners";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * Prefetches the FIRST keyset page of the runners grid for `query`, under EXACTLY the infinite key
 * `useKeysetList(orpc.runners.page, query)` asks for on first paint (#7484). oRPC builds that key
 * from `input(initialPageParam)`, and the initial page param is null on both sides, so the key is
 * the normalized query alone — the cursor is never in it (lib/query/README.md → "Paging": a route
 * that prefetches the first page uses `prefetchInfiniteQuery` with the same `infiniteOptions`).
 *
 * @param queryClient the request's query client, dehydrated by the route afterwards
 * @param query the `normalizeRunnersQuery()` output; `{}` is the pristine grid
 */
export async function prefetchRunnersList(queryClient: QueryClient, query: RunnersQuery): Promise<void> {
	await queryClient.prefetchInfiniteQuery(
		serverOrpc().runners.page.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: retryUnlessRefused,
		}),
	);
}

/**
 * Whether a cached query is one of the runners route's own reads (`runners.*`), and settled — the
 * route's `dehydrate` filter (R6 C-34). The server QueryClient is one per request, shared with the
 * `[org]` layout, which already hands its shell reads to the client through its own boundary;
 * without this filter the page serialized those reads into its HTML a second time. The clusters
 * routes filter the same way (`isClustersRead`).
 */
export function isRunnersRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "runners";
}
