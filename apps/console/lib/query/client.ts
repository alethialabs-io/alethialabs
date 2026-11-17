// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	QueryCache,
	QueryClient,
	defaultShouldDehydrateQuery,
	isServer,
	onlineManager,
} from "@tanstack/react-query";
import { cache } from "react";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

/**
 * The one place a read's UNAUTHORIZED is handled (`"sign-in"` in `lib/rpc/refusal.ts`): it ends the
 * session state, and `components/shell/session-ended.tsx` shows the dialog. Browser only — on the
 * server the store is one module instance for every request, so a prefetch must not write to it.
 */
function onReadError(error: unknown): void {
	if (isServer) return;
	if (readRefusalOf(error) === "sign-in") endSession();
}

/**
 * The default `retry`: once, as before, except that a read refused for want of a session is not
 * asked again — the second answer is the same, and it would only delay the session-ended dialog.
 */
function retryOnce(failureCount: number, error: unknown): boolean {
	return readRefusalOf(error) !== "sign-in" && failureCount < 1;
}

/**
 * Builds a QueryClient with the console's shared defaults. `staleTime` of 30s mirrors
 * the old hand-rolled store TTL so a freshly navigated page trusts server-prefetched
 * data without an immediate refetch, while `refetchOnWindowFocus` keeps long-lived tabs
 * current. Pending queries are allowed to dehydrate so a server prefetch that hasn't
 * resolved yet still streams to the client. A read refused with UNAUTHORIZED ends the session state
 * ({@link onReadError}).
 */
function makeQueryClient(): QueryClient {
	return new QueryClient({
		queryCache: new QueryCache({ onError: onReadError }),
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				refetchOnWindowFocus: true,
				retry: retryOnce,
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

/**
 * Stops the browser's reads once the session has ended. Runs once, when `useSessionState` becomes
 * `ended`, whichever of the three sources set it.
 *
 * - Every tenant's client cancels what it has in flight.
 * - TanStack's `onlineManager` is told the browser is offline, and its window listener is replaced
 *   with one that does nothing, so a later `online` event cannot undo that. A query in the default
 *   `networkMode` does not call its `queryFn` while the manager says offline: a refetch asked for
 *   by focus, a mount, an invalidation or the fallback poll is held as `paused` and sends nothing.
 *
 * What this does NOT hold: a query or mutation that sets `networkMode: "always"` (the action
 * mutation does, on purpose) still runs. And nothing here turns reads back on — the session-ended
 * dialog's "Sign in" is a full page load, which starts a new document.
 */
function haltQueries(): void {
	onlineManager.setEventListener(() => undefined);
	onlineManager.setOnline(false);
	for (const client of browserQueryClients.values()) void client.cancelQueries();
}

if (!isServer) {
	useSessionState.subscribe((state, previous) => {
		if (state.status === "ended" && previous.status !== "ended") haltQueries();
	});
}
