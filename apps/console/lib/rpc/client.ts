// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "@/lib/rpc/router";

/**
 * The read endpoint for the org the browser is CURRENTLY on, computed per call (stress test R1):
 * the first path segment is the tenant (`/acme/…`, or `~` for the personal scope), so a client-side
 * org switch can never send B's reads to A's endpoint.
 */
export function rpcUrl(pathname: string, origin: string): string {
	const segment = pathname.split("/")[1] || "~";
	return `${origin}/${segment}/~/rpc`;
}

const link = new RPCLink({
	url: () => {
		if (typeof window === "undefined") {
			throw new Error("The browser read client was called during a server render; prefetch with serverOrpc() instead.");
		}
		return rpcUrl(window.location.pathname, window.location.origin);
	},
	// Every procedure is a read declared GET (lib/rpc/base.ts). An input too long for a URL falls
	// back to POST — still a route handler, never a queued server action.
	method: () => "GET",
	fallbackMethod: "POST",
});

/** The typed browser client for the read router. */
export const rpcClient: RouterClient<AppRouter> = createORPCClient(link);

/**
 * TanStack Query helpers: `useQuery(orpc.jobs.page.queryOptions({ input }))`. Keys are
 * `[path, { input, type }]`; the tenant is NOT in them, which is why the browser keeps one
 * QueryClient per org (`lib/query/client.ts`).
 */
export const orpc = createTanstackQueryUtils(rpcClient);
