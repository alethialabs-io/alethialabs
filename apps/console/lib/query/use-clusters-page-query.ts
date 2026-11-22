// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The clusters list, step 5 of the console filter standard (./README.md → "Server-side filters"):
// the normalized query IS the input, the read is the SERVER's filtered page, and previous rows are
// kept — and visibly dimmed by the caller — while the next answer loads.
//
// No poll. A cluster that changes is a `clusters` hint on the org's change stream, and its
// environment's lifecycle and data services are `environments` hints; both invalidate every
// `clusters.*` key (lib/query/topics.ts). While the stream is down the one fallback poll covers it
// (lib/realtime/client/fallback-poll.ts).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/overview/overview-reads";
import { orpc } from "@/lib/rpc/client";
import type { ClustersPageInput } from "@/lib/rpc/procedures/clusters";

/**
 * The clusters in scope for `query`, filtered SERVER-SIDE, with the cloud, status and region facets
 * counted over every cluster in scope. `keepPreviousData` holds the table across a filter change;
 * the caller dims off `isPlaceholderData`. A typed refusal is not retried.
 *
 * @param query the `normalizeClustersQuery()` output; `{}` is the organization's pristine view
 */
export function useClustersPageQuery(query: ClustersPageInput = {}) {
	return useQuery(
		orpc.clusters.page.queryOptions({
			input: query,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}
