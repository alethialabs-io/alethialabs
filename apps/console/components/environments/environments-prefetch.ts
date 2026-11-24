// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import { environmentsQueryFromUrl } from "@/components/environments/environments-query";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import type { EnvironmentsListQuery } from "@/lib/rpc/procedures/environments";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * The first keyset page of the environments TABLE for `query`, under EXACTLY the infinite key
 * `useKeysetList(orpc.environments.page, query)` asks for: oRPC builds that key from
 * `input(initialPageParam)`, and the initial page param is null on both sides, so the key is the
 * normalized query alone — the cursor is never in it (lib/query/README.md → "Paging").
 */
function prefetchTablePage(queryClient: QueryClient, query: EnvironmentsListQuery) {
	return queryClient.prefetchInfiniteQuery(
		serverOrpc().environments.page.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
		}),
	);
}

/**
 * The paged reads of the Environments route (LST-3 #7485), beside the overview it prefetches
 * itself: the table's first page for the pristine list (`{ project }`, which the client renders
 * before its filter store has read the link) and for the link's filters (the key it settles on once
 * it has — the same key twice for a pristine link, which TanStack dedupes), and the promotions
 * history's first page. A prefetch that fails is not dehydrated; the view renders that read's own
 * error.
 */
export async function prefetchEnvironmentsLists(queryClient: QueryClient, project: string, params: ParamReader) {
	const promotions = { project };
	await Promise.all([
		prefetchTablePage(queryClient, { project }),
		prefetchTablePage(queryClient, environmentsQueryFromUrl(project, params)),
		queryClient.prefetchInfiniteQuery(
			serverOrpc().environments.promotions.infiniteOptions({
				input: (cursor: string | null) => (cursor === null ? promotions : { ...promotions, cursor }),
				initialPageParam: null,
				getNextPageParam: (last) => last.nextCursor,
			}),
		),
	]);
}
