// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";
import { serviceTokensQueryFromUrl } from "./tokens-filters";

/**
 * The service tokens route's prefetch: the FIRST page of `agents.serviceTokens` for the link's
 * filters, under exactly the infinite key `useKeysetList(orpc.agents.serviceTokens, …)` asks for on
 * first paint — the normalized query alone; the cursor is the page param and never in the key.
 */
export async function prefetchServiceTokens(queryClient: QueryClient, params: ParamReader): Promise<void> {
	const query = serviceTokensQueryFromUrl(params);
	await queryClient.prefetchInfiniteQuery(
		serverOrpc().agents.serviceTokens.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: retryUnlessRefused,
		}),
	);
}
