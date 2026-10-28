// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A pasted FILTERED link must have its filtered list on the wire (#4980, the audit's F8 on
// `~/runners?versions=…`; #4999 on `~/settings/members?statuses=…`). `~/alerts?policyStatus=…`
// prefetches over the read router since #6125: tests/app/alerts-route.test.tsx.
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

const { runnersPage, getMembersPage } = vi.hoisted(() => {
	/** A server action that answers with the query it was asked, so the dehydrated data names it. */
	const action = () => vi.fn(async (query: unknown) => ({ query, rows: [] }));
	return {
		runnersPage: action(),
		getMembersPage: action(),
	};
});

// The runners (#6123) and members (#6129) routes read over the read router in-process. ONE mock of
// `serverOrpc` carries both — a second `vi.mock` of the module would replace the first. The router here has the runners
// procedures' SHAPE, with the page read answering the input it was given; keys come from the same
// oRPC utilities the browser uses, so a key asserted below is the key the client looks up.
vi.mock("@/lib/rpc/server", async () => {
	const { os, createRouterClient } = await import("@orpc/server");
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { z } = await import("zod");
	const router = {
		runners: {
			page: os.input(z.record(z.string(), z.unknown())).handler(({ input }) => runnersPage(input)),
			list: os.handler(async () => ({ runners: [], latestRelease: null, releases: [] })),
			fleet: os.handler(async () => ({ pools: [] })),
			fleetEconomics: os.handler(async () => null),
		},
		// The members route prefetches through the same router since #6129: the page read answers the
		// input it was given, and the gate is a fixed answer.
		members: {
			page: os.input(z.record(z.string(), z.unknown())).handler(({ input }) => getMembersPage(input)),
			gate: os.handler(async () => ({ canManage: false, canInvite: false, plan: "community", inviteBlockedReason: "x" })),
		},
	};
	const utils = createTanstackQueryUtils(createRouterClient(router));
	return { serverOrpc: () => utils };
});
vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ userId: "u1", orgId: "o1" }) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ byoRunners: true }) }));
vi.mock("@/app/(private)/[org]/~/runners/runners-client", () => ({
	RunnersClient: () => null,
}));
vi.mock("@/components/runners/runners-skeleton", () => ({ RunnersSkeleton: () => null }));

vi.mock("@/components/settings/members/members-table", () => ({ MembersTable: () => null }));

// A fresh client per route call — the browser singleton would carry one test's keys into the next.
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => new QueryClient() }));

import RunnersRoute from "@/app/(private)/[org]/~/runners/page";
import { serverOrpc } from "@/lib/rpc/server";
import MembersRoute from "@/app/(private)/[org]/~/settings/members/page";

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

/**
 * Render the runners route for one link. The route renders its prefetching part inside a
 * `<Suspense>` (the plan gate is decided first, #6123), so the async child is rendered here too.
 */
async function runners(searchParams: SearchParams): Promise<DehydratedState> {
	const node = await RunnersRoute({ searchParams: Promise.resolve(searchParams) });
	if (!isValidElement<{ children?: ReactNode }>(node) || !isValidElement(node.props.children)) {
		throw new Error("the runners route did not render its prefetching part");
	}
	const child = node.props.children;
	if (typeof child.type !== "function") throw new Error("the prefetching part is not a component");
	// An async server component: a plain function of its props.
	return dehydratedOf(await Reflect.apply(child.type, undefined, [child.props]));
}

/** The browser's key for the runners grid's page read with `input`. */
function runnersPageKey(input: Record<string, unknown>): readonly unknown[] {
	return serverOrpc().runners.page.queryKey({ input });
}

/** The browser's key for the members page read of `query` (`orpc.members.page`). */
function membersKey(query: unknown): readonly unknown[] {
	return [["members", "page"], { input: query, type: "query" }];
}

/** Render the members route for one link. */
async function members(searchParams: SearchParams): Promise<DehydratedState> {
	return dehydratedOf(
		await MembersRoute({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve(searchParams) }),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("~/runners prefetches the link's filtered grid", () => {
	it("dehydrates the FILTERED key the client settles on, with the server's filtered answer", async () => {
		const state = await runners({ versions: "1.4.0,1.10.0" });
		// Sorted by the normalize step — the key the client builds, character for character.
		const filtered = runnersPageKey({ versions: ["1.10.0", "1.4.0"] });
		expect(dataAt(state, filtered)).toEqual({ query: { versions: ["1.10.0", "1.4.0"] }, rows: [] });
		expect(runnersPage).toHaveBeenCalledWith({ versions: ["1.10.0", "1.4.0"] });
	});

	it("still dehydrates the pristine key — the hydration render holds the store's defaults", async () => {
		const state = await runners({ versions: "1.4.0" });
		expect(dataAt(state, runnersPageKey({}))).toEqual({ query: {}, rows: [] });
	});

	it("fetches the pristine grid once for a pristine link", async () => {
		await runners({});
		expect(runnersPage).toHaveBeenCalledTimes(1);
	});
});

describe("~/settings/members prefetches the link's filtered list (#4999)", () => {
	it("dehydrates the FILTERED key the client settles on, with the server's filtered answer", async () => {
		const state = await members({ statuses: "pending", roles: "viewer,admin", search: "  ann " });
		// Trimmed and sorted by the normalize step — the key the client builds, character for character.
		const query = { search: "ann", statuses: ["pending"], roles: ["admin", "viewer"] };
		expect(dataAt(state, membersKey(query))).toEqual({ query, rows: [] });
		expect(getMembersPage).toHaveBeenCalledWith(query);
	});

	it("still dehydrates the pristine key — the hydration render holds the store's defaults", async () => {
		const state = await members({ statuses: "pending" });
		expect(dataAt(state, membersKey({}))).toEqual({ query: {}, rows: [] });
		// Never the member LIST (`members.list`): a different payload shape, and seeding it with a
		// page would serve the wrong one.
		expect(keysOf(state).some((k) => k.includes('"list"'))).toBe(false);
	});

	it("ignores params the members filters do not map", async () => {
		await members({ versions: "1.4.0" });
		expect(getMembersPage).toHaveBeenCalledTimes(1);
		expect(getMembersPage).toHaveBeenCalledWith({});
	});
});
