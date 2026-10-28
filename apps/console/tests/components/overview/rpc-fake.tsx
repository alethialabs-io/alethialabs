// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the browser read client (`@/lib/rpc/client`) for the overview's card tests (#6118).
//
// The cards build their reads with `orpc.<path>.queryOptions(...)`. The test files mock
// `@/lib/rpc/client` with `createTanstackQueryUtils(fakeClient)` — the REAL utils over a fake
// transport — so each card's query key is the key the browser uses, and a test controls only what
// the read answers. `renderWithReads` mounts a card under a fresh QueryClient; `seed` puts an
// answer in the cache exactly as the page's server prefetch would.

import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

/** What each read the overview makes answers; replace per test. */
export const reads = {
	usage: vi.fn<(input: unknown) => Promise<unknown>>(),
	alerts: vi.fn<(input: unknown) => Promise<unknown>>(),
	recentJobs: vi.fn<(input: unknown) => Promise<unknown>>(),
};

/** The fake transport: the router's shape, each procedure answering from `reads`. */
const fakeClient = {
	overview: {
		usage: (input: unknown) => reads.usage(input),
		alerts: (input: unknown) => reads.alerts(input),
	},
	workspace: {
		recentJobs: (input: unknown) => reads.recentJobs(input),
	},
};

/** The `orpc` export the mocked `@/lib/rpc/client` module provides. */
export const fakeOrpc = createTanstackQueryUtils(fakeClient);

/** A read that never answers — the pending state. */
export function never(): Promise<unknown> {
	return new Promise(() => {});
}

/** The read router's typed FORBIDDEN refusal, as the browser receives it. */
export function forbidden(): ORPCError<"FORBIDDEN", undefined> {
	return new ORPCError("FORBIDDEN", { defined: true, status: 403 });
}

/** A test QueryClient: no retries beyond what a query asks for, nothing goes stale mid-test. */
export function testClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retryDelay: 0 } } });
}

/** Renders `ui` under `client` (a fresh one by default). */
export function renderWithReads(ui: ReactElement, client: QueryClient = testClient()) {
	return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}
