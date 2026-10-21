// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The connectors board's read (#6124, ADR 0005 D1): one `connectors.board` GET per normalized filter
// (the console filter standard — the normalized query is the input, so the key), prefetched by the
// route for the link's filter and hydrated, so the first paint carries the board. Live through the
// `connectors` topic on the org's change stream (lib/query/topics.ts); there is no poll.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/connectors/connectors-board";
import type { NormalizedConnectorQuery } from "@/components/connectors/connectors-query";
import { orpc } from "@/lib/rpc/client";

/**
 * The board read for one normalized filter — the input, so the key (filter standard F3). The route
 * prefetches the link's filter, so the first paint is a cache hit. `keepPreviousData` holds the rows
 * (dimmed) while a new filter's answer is fetched. `staleTime` is minutes, not the console's 30 s
 * default: a change the viewer did not make arrives as a `connectors` hint, and the viewer's own
 * writes invalidate it directly.
 */
export function useConnectorsQuery(input: NormalizedConnectorQuery) {
	return useQuery(
		orpc.connectors.board.queryOptions({
			input,
			placeholderData: keepPreviousData,
			staleTime: 5 * 60_000,
			retry: retryUnlessRefused,
		}),
	);
}
