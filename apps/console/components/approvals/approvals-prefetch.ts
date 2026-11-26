// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import {
	approvalsQueryFromUrl,
	DEFAULT_APPROVALS_FILTERS,
	normalizeApprovalsQuery,
} from "@/components/approvals/approvals-query";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import { selectionFromUrl } from "@/lib/query/view-url-params";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";

/** A UUID: the only shape `approvals.get` accepts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approvals route's prefetch: the FIRST keyset page of `approvals.list` under exactly the infinite
 * key `useKeysetList(orpc.approvals.list, …)` asks for (the cursor is the page param, never in the
 * key), for the pristine view the client renders before its store has read the link AND for the
 * link's filters it settles on — one key twice for a bare link, which TanStack dedupes. When the link
 * names an approval (`?selected=<id>`), its sheet's read too, so a deep link opens the sheet with no
 * second request and without paging the list to find the row. A prefetch that fails is not
 * dehydrated; the client then renders its own refusal or error.
 */
export async function prefetchApprovalsRoute(queryClient: QueryClient, params: ParamReader): Promise<void> {
	const rpc = serverOrpc();
	const firstPage = (query: ReturnType<typeof normalizeApprovalsQuery>) =>
		queryClient.prefetchInfiniteQuery(
			rpc.approvals.list.infiniteOptions({
				input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
				initialPageParam: null,
				getNextPageParam: (last) => last.nextCursor,
				retry: retryUnlessRefused,
			}),
		);
	const selected = selectionFromUrl(params);
	await Promise.all([
		firstPage(normalizeApprovalsQuery(DEFAULT_APPROVALS_FILTERS)),
		firstPage(approvalsQueryFromUrl(params)),
		selected && UUID.test(selected)
			? queryClient.prefetchQuery(rpc.approvals.get.queryOptions({ input: { id: selected }, retry: false }))
			: null,
	]);
}
