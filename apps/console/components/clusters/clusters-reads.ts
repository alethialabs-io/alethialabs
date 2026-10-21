// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client" and no server imports: both clusters routes (server) use this as their dehydrate
// filter.

import type { Query } from "@tanstack/react-query";

/**
 * Whether a cached query is the clusters read (`clusters.*`), and settled — the clusters routes'
 * `dehydrate` filter. The server QueryClient is one per request (`cache()`), shared with the `[org]`
 * layout, which already hands its shell reads to the client through its own boundary; without this
 * filter the page would serialize those reads into its HTML a second time.
 */
export function isClustersRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "clusters";
}
