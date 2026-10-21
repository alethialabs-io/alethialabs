// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the browser read client (`@/lib/rpc/client`) for the billing and usage pages'
// component tests (#6127).
//
// The panels build their reads with `orpc.<domain>.<proc>.queryOptions(...)`. A test file mocks
// `@/lib/rpc/client` with `createTanstackQueryUtils(fakeClient)` — the REAL TanStack utils over a
// fake transport — so every query key is the key the browser uses, and a test controls only what
// each read answers. `seed` puts an answer in the cache exactly as the route's server prefetch
// does, so a test can assert the first paint without a fetch.

import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

/** One read's answer function. */
type Read = ReturnType<typeof vi.fn<(input: unknown) => Promise<unknown>>>;

/** A fresh, never-answering read. */
function read(): Read {
	return vi.fn<(input: unknown) => Promise<unknown>>(() => new Promise(() => {}));
}

/** What each billing / usage read answers; reset with {@link resetReads}. */
export const reads = {
	summary: read(),
	paymentMethods: read(),
	invoices: read(),
	transactions: read(),
	planHistory: read(),
	liveAiPrices: read(),
	org: read(),
	resources: read(),
	overTime: read(),
	ai: read(),
	project: read(),
	projectResources: read(),
	projectAi: read(),
	projectOverTime: read(),
};

/** Puts every read back to "never answers" (the pending state). */
export function resetReads(): void {
	for (const fn of Object.values(reads)) {
		fn.mockReset();
		fn.mockImplementation(() => new Promise(() => {}));
	}
}

/** The fake transport: the router's shape, each procedure answering from `reads`. */
const fakeClient = {
	billing: {
		summary: (input: unknown) => reads.summary(input),
		paymentMethods: (input: unknown) => reads.paymentMethods(input),
		invoices: (input: unknown) => reads.invoices(input),
		transactions: (input: unknown) => reads.transactions(input),
		planHistory: (input: unknown) => reads.planHistory(input),
		liveAiPrices: (input: unknown) => reads.liveAiPrices(input),
	},
	usage: {
		org: (input: unknown) => reads.org(input),
		resources: (input: unknown) => reads.resources(input),
		overTime: (input: unknown) => reads.overTime(input),
		ai: (input: unknown) => reads.ai(input),
		project: (input: unknown) => reads.project(input),
		projectResources: (input: unknown) => reads.projectResources(input),
		projectAi: (input: unknown) => reads.projectAi(input),
		projectOverTime: (input: unknown) => reads.projectOverTime(input),
	},
};

/** The `orpc` export the mocked `@/lib/rpc/client` module provides. */
export const fakeOrpc = createTanstackQueryUtils(fakeClient);

/** The read router's typed refusal, as the browser receives it. */
export function refused(code: "FORBIDDEN" | "ENTITLEMENT_REQUIRED" | "NOT_FOUND") {
	return new ORPCError(code, { defined: true, status: code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 402 });
}

/** A real failure: an undefined (untyped) error, as a 500 reaches the browser. */
export function failed() {
	return new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
}

/** A test QueryClient: no retry delay, nothing goes stale mid-test. */
export function testClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retryDelay: 0 } } });
}

/** Renders `ui` under `client` (a fresh one by default). */
export function renderWithReads(ui: ReactElement, client: QueryClient = testClient()) {
	return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}
