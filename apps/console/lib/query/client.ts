// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	QueryClient,
	defaultShouldDehydrateQuery,
	isServer,
} from "@tanstack/react-query";
import { cache } from "react";

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

/**
 * One request-scoped client per server render (#6113). `cache()` memoises inside a React server
 * render, so every component that prefetches in one request shares one client and one dehydrated
 * state; outside a server render it is a pass-through, i.e. a fresh client per call as before.
 */
const serverQueryClient = cache(makeQueryClient);

/**
 * Browser clients, ONE PER TENANT SCOPE (#6113, ADR 0005 stress test R1). oRPC query keys are
 * `[path, { input, type }]` and carry no org, so a single browser-wide client would serve org A's
 * cached rows under org B's address after a client-side org switch. A client per org segment
 * makes a cross-org cache hit impossible by construction rather than by key discipline.
 */
const browserQueryClients = new Map<string, QueryClient>();

/** The scope key used before any org is known (sign-in, onboarding, the CLI hand-off). */
export const UNSCOPED = "";

/**
 * Returns a QueryClient that is request-scoped on the server (caches never leak across users or
 * requests) and, in the browser, one long-lived client per tenant scope — the org segment of the
 * URL — so React suspense re-renders keep the cache while switching org never shows another org's
 * rows. This is the Next.js App Router pattern for server prefetch + client hydration, extended
 * with the tenant partition.
 */
export function getQueryClient(scope: string = UNSCOPED): QueryClient {
	if (isServer) return serverQueryClient();
	let client = browserQueryClients.get(scope);
	if (!client) {
		client = makeQueryClient();
		browserQueryClients.set(scope, client);
	}
	return client;
}
