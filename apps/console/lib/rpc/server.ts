// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { createRouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { cache } from "react";
import { currentActor } from "@/lib/authz/guard";
import { router } from "@/lib/rpc/router";

/**
 * The read router called IN-PROCESS from a server component (ADR 0005 D1.4): no HTTP hop, same
 * procedures, same input validation, same query keys as the browser. The actor resolves from the
 * page request's own address, exactly as the `/{org}/~/rpc` handler resolves it for the browser.
 * `cache()` makes it one client per server render.
 */
const serverRpc = cache(() =>
	createTanstackQueryUtils(
		createRouterClient(router, {
			context: async () => ({ actor: await currentActor() }),
		}),
	),
);

/**
 * TanStack Query helpers over the in-process router, for RSC prefetch:
 * `await getQueryClient().prefetchQuery(serverOrpc().jobs.page.queryOptions({ input }))`.
 * The keys equal the browser's (`orpc` in `lib/rpc/client.ts`), so the dehydrated entry is the one
 * the client reads on first paint.
 */
export function serverOrpc() {
	return serverRpc();
}
