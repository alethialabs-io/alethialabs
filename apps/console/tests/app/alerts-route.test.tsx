// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6125 — the alerts route decides its gates on the server and paints the hub with its data.
//
//   · F021: an org without alerting gets the upsell, a member without `view_alerts` the no-access
//     notice — and NEITHER is shown a hub skeleton first or has any read prefetched for it.
//   · RUBRIC B1: past the gates, every key the hub asks for on first paint is prefetched in-process
//     through the read router — the settings, each list's PRISTINE page (the hydration render and the
//     panels' universes) and each list for the link's filters (#4980, the audit's F8) — under EXACTLY
//     the keys the browser's hooks build, compared with the hooks rather than with a literal.
//   · Only this route's reads are serialized: the `[org]` layout shares the request's QueryClient.
//
// The route is called as a plain async function. Its `<Suspense>` child (the prefetching component)
// is an async function component, called the same way to read the `HydrationBoundary` it returns.

import { QueryClient, type DehydratedState } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
	client: null as QueryClient | null,
	canView: true,
	alerting: true,
}));

vi.mock("@/lib/rpc/server", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { serverOrpc: () => fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("@/lib/query/client", () => ({
	getQueryClient: () => {
		if (!h.client) throw new Error("no client");
		return h.client;
	},
}));
vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({
		userId: "u1",
		orgId: "org-1",
		entitlements: { alerting: h.alerting, advancedAlerting: false },
	})),
}));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({ can: vi.fn(async () => ({ allowed: h.canView })) }),
}));
vi.mock("@/components/alerts/alerts-page", () => ({ AlertsPage: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: (props: { feature: string }) => props.feature,
}));

const { default: AlertsRoute } = await import("@/app/(private)/[org]/~/alerts/page");
const { AlertsSkeleton } = await import("@/components/alerts/alerts-skeleton");
const { FeatureUpsell } = await import("@/components/settings/upgrade/feature-upsell");
const { orpc } = await import("@/lib/rpc/client");

type SearchParams = Record<string, string | string[] | undefined>;

/** Answers each list with the query it was asked, so the dehydrated data names it. */
function answerEverything() {
	h.handlers = {
		"alerts.settings": async () => ({ alerting: true }),
		"alerts.policies": async (input) => ({ query: input, rows: [], total: 0 }),
		"alerts.channels": async (input) => ({ query: input, rows: [], total: 0 }),
		"alerts.deliveries": async (input) => ({ query: input, rows: [], total: 0 }),
		"workspace.projects": async () => [],
	};
}

/** The browser's key for an alerts read, built the way the hooks build it. */
function clientKey(procedure: string, input?: unknown): string {
	const node: unknown = Reflect.get(Reflect.get(Object(orpc), "alerts"), procedure);
	const queryKey: unknown = Reflect.get(Object(node), "queryKey");
	if (typeof queryKey !== "function") throw new Error(`no ${procedure}`);
	return JSON.stringify(queryKey(input === undefined ? undefined : { input }));
}

/** The route's output for one link. */
function route(searchParams: SearchParams): Promise<ReactNode> {
	return AlertsRoute({ searchParams: Promise.resolve(searchParams) });
}

/** The hub's dehydrated state: the Suspense child, rendered, and its HydrationBoundary's `state`. */
async function dehydrated(node: ReactNode): Promise<DehydratedState> {
	if (!isValidElement<{ children: ReactElement; fallback: ReactNode }>(node)) throw new Error("not an element");
	const child = node.props.children;
	const render: unknown = child.type;
	if (typeof render !== "function") throw new Error("the Suspense child is not a component");
	const rendered: unknown = await render(child.props);
	if (!isValidElement<{ state?: DehydratedState }>(rendered) || rendered.props.state === undefined) {
		throw new Error("the hub did not render a HydrationBoundary with a state");
	}
	return rendered.props.state;
}

/** Every dehydrated key, JSON-encoded. */
function keysOf(state: DehydratedState): string[] {
	return state.queries.map((q) => JSON.stringify(q.queryKey));
}

beforeEach(() => {
	h.calls.length = 0;
	h.client = new QueryClient();
	h.canView = true;
	h.alerting = true;
	answerEverything();
});

describe("the gates are decided on the server (F021)", () => {
	it("a member without view_alerts gets the no-access notice, and nothing is read", async () => {
		h.canView = false;
		const node = await route({});
		expect(JSON.stringify(node)).toContain("No access to alerts");
		expect(h.calls).toEqual([]);
	});

	it("an org without alerting gets the upsell — not a hub skeleton — and nothing is read", async () => {
		h.alerting = false;
		const node = await route({});
		expect(isValidElement(node) && node.type).toBe(FeatureUpsell);
		expect(h.calls).toEqual([]);
	});

	it("past both gates, the fallback is the hub's own skeleton", async () => {
		const node = await route({});
		expect(isValidElement<{ fallback: ReactNode }>(node) && isValidElement(node.props.fallback)).toBe(true);
		if (isValidElement<{ fallback: ReactElement }>(node)) expect(node.props.fallback.type).toBe(AlertsSkeleton);
	});
});

describe("the first paint carries the hub's reads (B1)", () => {
	it("prefetches the settings and each list's pristine page under the browser's keys", async () => {
		const keys = keysOf(await dehydrated(await route({})));
		expect(keys).toEqual(
			expect.arrayContaining([
				clientKey("settings"),
				clientKey("policies", {}),
				clientKey("channels", {}),
				clientKey("deliveries", {}),
			]),
		);
	});

	it("a filtered link also prefetches the FILTERED key each panel settles on, with that answer", async () => {
		const state = await dehydrated(await route({ policyStatus: "off", channelType: "slack", activityStatus: "failed" }));
		const at = (key: string) => state.queries.find((q) => JSON.stringify(q.queryKey) === key)?.state.data;
		expect(at(clientKey("policies", { status: ["off"] }))).toEqual({ query: { status: ["off"] }, rows: [], total: 0 });
		expect(at(clientKey("channels", { types: ["slack"] }))).toBeDefined();
		expect(at(clientKey("deliveries", { status: ["failed"] }))).toBeDefined();
		// Each prefixed param reaches ITS panel and no other.
		expect(h.calls.filter((c) => c.path === "alerts.policies").map((c) => c.input)).toEqual(
			expect.not.arrayContaining([expect.objectContaining({ types: expect.anything() })]),
		);
		// And the pristine pages beside them, for the hydration render.
		expect(keysOf(state)).toContain(clientKey("policies", {}));
	});

	it("serializes only this route's answered reads — not the layout's, not a failed one", async () => {
		// A shell read the [org] layout put in the shared request client.
		await h.client?.prefetchQuery({ queryKey: [["workspace", "projects"], { type: "query" }], queryFn: async () => [] });
		h.handlers["alerts.deliveries"] = async () => {
			throw new Error("boom");
		};
		const keys = keysOf(await dehydrated(await route({})));
		expect(keys.some((k) => k.includes("workspace"))).toBe(false);
		expect(keys).not.toContain(clientKey("deliveries", {}));
		expect(keys).toContain(clientKey("policies", {}));
	});
});
