// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	QueryClient,
	defaultShouldDehydrateQuery,
	isServer,
} from "@tanstack/react-query";

/**
 * Builds a QueryClient with the console's shared defaults. `staleTime` of 30s mirrors
 * the old hand-rolled store TTL so a freshly navigated page trusts server-prefetched
 * data without an immediate refetch, while `refetchOnWindowFocus` keeps long-lived tabs
 * current. Pending queries are allowed to dehydrate so a server prefetch that hasn't
 * resolved yet still streams to the client.
 */
function makeQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				refetchOnWindowFocus: true,
				retry: 1,
			},
			dehydrate: {
				// Include still-pending queries so `void prefetchQuery` streams to the client.
				shouldDehydrateQuery: (query) =>
					defaultShouldDehydrateQuery(query) ||
					query.state.status === "pending",
			},
		},
	});
}

let browserQueryClient: QueryClient | undefined;

/**
 * Returns a QueryClient that is request-scoped on the server (a fresh client per render
 * so caches never leak across users/requests) and a process-wide singleton in the
 * browser (so React suspense re-renders don't discard the cache). This is the official
 * Next.js App Router pattern for server prefetch + client hydration.
 */
export function getQueryClient(): QueryClient {
	if (isServer) return makeQueryClient();
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}
