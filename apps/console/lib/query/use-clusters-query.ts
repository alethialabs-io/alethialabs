// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// #6122 (ADR 0005 D1): the clusters read is the `clusters.list` GET procedure, prefetched on the
// server by both clusters routes under this same key, so the grid paints with its data.
//
// No poll. A cluster that changes is a `clusters` hint on the org's change stream, and its
// environment's lifecycle and data services are `environments` hints; both invalidate this key
// (lib/query/topics.ts). While the stream is down, the one fallback poll covers it
// (lib/realtime/client/fallback-poll.ts).

import { useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/overview/overview-reads";
import { orpc } from "@/lib/rpc/client";

/**
 * Every cluster under management in the org the browser is on (lib/rpc/procedures/clusters.ts). A
 * typed refusal is not retried: it answers the same the second time.
 */
export function useClustersQuery() {
	return useQuery(orpc.clusters.list.queryOptions({ retry: retryUnlessRefused }));
}
