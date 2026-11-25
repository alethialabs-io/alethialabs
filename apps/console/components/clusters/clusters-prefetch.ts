// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import { clustersQueryFromUrl } from "@/components/clusters/clusters-query";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import { selectionFromUrl } from "@/lib/query/view-url-params";
import type { ClustersListQuery } from "@/lib/rpc/procedures/clusters";
import { serverOrpc } from "@/lib/rpc/server";

/** The shape of a cluster id; any other `?selected=` value opens nothing and is not asked. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The first keyset page of `clusters.page` for `query`, under EXACTLY the infinite key
 * `useKeysetList(orpc.clusters.page, query)` asks for: oRPC builds that key from
 * `input(initialPageParam)`, and the initial page param is null on both sides, so the key is the
 * normalized query alone — the cursor is never in it (lib/query/README.md → "Paging"). Not
 * retried: a failed prefetch is not dehydrated, and the list renders its own refusal or error.
 */
function prefetchFirstPage(queryClient: QueryClient, query: ClustersListQuery) {
	return queryClient.prefetchInfiniteQuery(
		serverOrpc().clusters.page.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: false,
		}),
	);
}

/**
 * Both clusters routes' prefetch, shared so the two cannot drift apart. Two first pages, as every
 * list on the filter standard: the pristine one (`{}` or `{ projectId }`), which the client renders
 * before its filter store has read the link, and the one for the link's filters, the key it settles
 * on once it has — the same key twice for a pristine link, which TanStack dedupes. And, when the
 * link opens a cluster (`?selected=`), that cluster by id (`clusters.detail`), under the key the
 * client asks while the row is not on a loaded page — so a deep link's drawer is in the first paint
 * whichever page its row is on.
 *
 * @param projectId the project a project route lists (its SCOPE); undefined on the org route
 */
export async function prefetchClustersList(queryClient: QueryClient, params: ParamReader, projectId?: string) {
	const pristine: ClustersListQuery = projectId ? { projectId } : {};
	const selected = selectionFromUrl(params);
	await Promise.all([
		prefetchFirstPage(queryClient, pristine),
		prefetchFirstPage(queryClient, clustersQueryFromUrl(params, projectId)),
		selected !== null && UUID.test(selected)
			? queryClient.prefetchQuery(
					serverOrpc().clusters.detail.queryOptions({
						input: { clusterId: selected, ...(projectId ? { projectId } : {}) },
						retry: false,
					}),
				)
			: null,
	]);
}
