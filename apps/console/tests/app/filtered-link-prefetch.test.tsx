// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A pasted FILTERED link must have its filtered list on the wire (#4980, the audit's F8 on
// `~/runners?versions=…` and `~/alerts?policyStatus=…`).
//
// Both routes used to prefetch only the pristine key. The client renders pristine, reads the URL
// in a mount effect, and then asks for the filtered key — which arrived with no data, so
// `keepPreviousData` held the UNFILTERED rows up under a URL that said otherwise until the server
// action returned. What is asserted here is the thing the client will look up: the dehydrated
// state carries the key `useFilterUrlSync` + the normalize step produce for the link, with the
// server's filtered answer in it — and still carries the pristine key the hydration render asks
// for first.
//
// The routes are called as plain async functions and their `HydrationBoundary` state is read off
// the returned element. Every data read is mocked at the server-action seam, so the queryFn that
// ran is visible by the argument it was called with.

import { QueryClient, type DehydratedState } from "@tanstack/react-query";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRunnersPage, getAlertPoliciesPage, getAlertChannelsPage, getAlertDeliveriesPage } = vi.hoisted(() => {
	/** A server action that answers with the query it was asked, so the dehydrated data names it. */
	const action = () => vi.fn(async (query: unknown) => ({ query, rows: [] }));
	return {
		getRunnersPage: action(),
		getAlertPoliciesPage: action(),
		getAlertChannelsPage: action(),
		getAlertDeliveriesPage: action(),
	};
});

vi.mock("@/app/server/actions/runners", () => ({ getRunnersPage }));
vi.mock("@/lib/query/resource-fetchers", () => ({
	fetchRunnersData: async () => [],
	fetchFleetData: async () => null,
}));
vi.mock("@/app/(private)/[org]/~/runners/runners-client", () => ({
	RunnersClient: () => null,
}));

vi.mock("@/app/server/actions/alerts", () => ({
	getAlertsBootstrap: async () => ({ alerting: true }),
	getAlertPoliciesPage,
	getAlertChannelsPage,
	getAlertDeliveriesPage,
}));
vi.mock("@/components/alerts/alerts-page", () => ({ AlertsPage: () => null }));

// A fresh client per route call — the browser singleton would carry one test's keys into the next.
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => new QueryClient() }));

import AlertsRoute from "@/app/(private)/[org]/~/alerts/page";
import RunnersRoute from "@/app/(private)/[org]/~/runners/page";

type SearchParams = Record<string, string | string[] | undefined>;

/** The `HydrationBoundary` state a route rendered, or a thrown error naming what came back. */
function dehydratedOf(node: ReactNode): DehydratedState {
	if (!isValidElement<{ state?: DehydratedState }>(node) || node.props.state === undefined) {
		throw new Error("the route did not render a HydrationBoundary with a state");
	}
	return node.props.state;
}

/** Every dehydrated query key, JSON-encoded so arrays of objects compare by value. */
function keysOf(state: DehydratedState): string[] {
	return state.queries.map((q) => JSON.stringify(q.queryKey));
}

/** The dehydrated data under one key, or undefined when that key was never prefetched. */
function dataAt(state: DehydratedState, key: readonly unknown[]): unknown {
	return state.queries.find((q) => JSON.stringify(q.queryKey) === JSON.stringify(key))?.state.data;
}

/** Render the runners route for one link. */
async function runners(searchParams: SearchParams): Promise<DehydratedState> {
	return dehydratedOf(
		await RunnersRoute({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve(searchParams) }),
	);
}

/** Render the alerts route for one link. */
async function alerts(searchParams: SearchParams): Promise<DehydratedState> {
	return dehydratedOf(
		await AlertsRoute({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve(searchParams) }),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("~/runners prefetches the link's filtered grid", () => {
	it("dehydrates the FILTERED key the client settles on, with the server's filtered answer", async () => {
		const state = await runners({ versions: "1.4.0,1.10.0" });
		// Sorted by the normalize step — the key the client builds, character for character.
		const filtered = ["runners", "acme", "page", { versions: ["1.10.0", "1.4.0"] }];
		expect(dataAt(state, filtered)).toEqual({ query: { versions: ["1.10.0", "1.4.0"] }, rows: [] });
		expect(getRunnersPage).toHaveBeenCalledWith({ versions: ["1.10.0", "1.4.0"] });
	});

	it("still dehydrates the pristine key — the hydration render holds the store's defaults", async () => {
		const state = await runners({ versions: "1.4.0" });
		expect(dataAt(state, ["runners", "acme", "page", {}])).toEqual({ query: {}, rows: [] });
	});

	it("fetches the pristine grid once for a pristine link", async () => {
		await runners({});
		expect(getRunnersPage).toHaveBeenCalledTimes(1);
	});
});

describe("~/alerts prefetches each panel's filtered list", () => {
	it("dehydrates the policies key a `policyStatus` link settles on", async () => {
		const state = await alerts({ policyStatus: "off" });
		expect(dataAt(state, ["alerts", "policies", "acme", { status: ["off"] }])).toEqual({
			query: { status: ["off"] },
			rows: [],
		});
		// And the pristine lists beside it, for the hydration render.
		expect(keysOf(state)).toContain(JSON.stringify(["alerts", "policies", "acme", {}]));
	});

	it("routes each prefixed param to ITS panel and no other", async () => {
		const state = await alerts({ channelType: "slack", activityStatus: "failed" });
		expect(dataAt(state, ["alerts", "channels", "acme", { types: ["slack"] }])).toBeDefined();
		expect(dataAt(state, ["alerts", "deliveries", "acme", { status: ["failed"] }])).toBeDefined();
		expect(getAlertPoliciesPage).not.toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() }));
	});
});
