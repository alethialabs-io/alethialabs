// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6132 / F021: the SSO route decides its plan gate on the SERVER, as the runners (#6123), alerts
// (#6125) and teams (#6129) routes do. An org without `sso` gets the upsell as the whole body with
// no provider read prefetched, and the route's loading state draws that answer — never the
// toolbar, filter bar and provider panel the page will not render.
//
// #6129 part 2: the route reads over the read router in-process (`sso.bootstrap`, `sso.providers`),
// prefetches the pristine list AND the link's filtered list under the keys the browser asks for, and
// renders a viewer the bootstrap refuses (`member:view`) as the no-access state — not as an error and
// not as an empty list (B4).

import { type DehydratedState, QueryClient } from "@tanstack/react-query";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	sso: false,
	refuse: false,
	listed: [] as unknown[],
}));

vi.mock("@/lib/rpc/server", async () => {
	const { os, createRouterClient } = await import("@orpc/server");
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { z } = await import("zod");
	const base = os.errors({ FORBIDDEN: { status: 403, message: "You don't have permission to see this." } });
	const router = {
		sso: {
			bootstrap: base.handler(async ({ errors }) => {
				if (h.refuse) throw errors.FORBIDDEN();
				return { sso: h.sso, canManage: true, orgId: "o1", slug: "acme", origin: "https://c.test" };
			}),
			providers: base.input(z.record(z.string(), z.unknown())).handler(async ({ input }) => {
				h.listed.push(input);
				return [];
			}),
		},
	};
	const utils = createTanstackQueryUtils(createRouterClient(router));
	return { serverOrpc: () => utils };
});
vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ userId: "u1", orgId: "o1" }) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ sso: h.sso }) }));
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => new QueryClient() }));
vi.mock("@/components/settings/sso/sso-manager", () => ({ SsoManager: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: ({ feature }: { feature: string }) => <div data-upsell={feature}>upsell</div>,
}));
vi.mock("@/components/settings/members/people-skeleton", () => ({
	PeopleUpsellSkeleton: ({ toolbar }: { toolbar?: boolean }) => <div data-upsell-skeleton={String(toolbar)} />,
}));

import SsoLoading from "@/app/(private)/[org]/~/settings/sso/loading";
import SsoPage from "@/app/(private)/[org]/~/settings/sso/page";
import { SsoNoAccess } from "@/components/settings/sso/sso-no-access";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { PeopleUpsellSkeleton } from "@/components/settings/members/people-skeleton";

/** Renders the route for org `acme` and a link's query. */
function route(searchParams: Record<string, string> = {}): Promise<ReactNode> {
	return SsoPage({ params: Promise.resolve({ org: "acme" }), searchParams: Promise.resolve(searchParams) });
}

/** Every dehydrated query key the route handed the browser, JSON-encoded. */
function dehydratedKeys(node: ReactNode): string[] {
	if (!isValidElement<{ state?: DehydratedState }>(node) || node.props.state === undefined) {
		throw new Error("the route did not render a HydrationBoundary with a state");
	}
	return node.props.state.queries.map((q) => JSON.stringify(q.queryKey));
}

/** The browser's key for the provider list read with `input` (`orpc.sso.providers`). */
function providersKey(input: unknown): string {
	return JSON.stringify([["sso", "providers"], { input, type: "query" }]);
}

beforeEach(() => {
	h.listed = [];
	h.refuse = false;
});

describe("the SSO route's plan gate (F021)", () => {
	it("renders the upsell, and prefetches no provider read, for an org without SSO", async () => {
		h.sso = false;
		const node = await route();
		expect(isValidElement(node) && node.type === FeatureUpsell).toBe(true);
		expect(isValidElement<{ feature: string }>(node) && node.props.feature).toBe("sso");
		expect(h.listed).toEqual([]);
	});

	it("prefetches the provider list and hands it to the browser for an entitled org", async () => {
		h.sso = true;
		const node = await route();
		expect(isValidElement(node) && node.type === FeatureUpsell).toBe(false);
		expect(h.listed).toEqual([{}]);
		expect(dehydratedKeys(node)).toContain(providersKey({}));
		expect(dehydratedKeys(node)).toContain(JSON.stringify([["sso", "bootstrap"], { type: "query" }]));
	});

	it("prefetches a pasted filtered link's list under the key the list will ask for, beside the pristine one", async () => {
		h.sso = true;
		const node = await route({ statuses: "pending", search: " okta " });
		const keys = dehydratedKeys(node);
		expect(keys).toContain(providersKey({}));
		expect(keys).toContain(providersKey({ search: "okta", statuses: ["pending"] }));
	});

	it("renders the no-access state, and prefetches nothing, for a viewer the bootstrap refuses", async () => {
		h.sso = true;
		h.refuse = true;
		const node = await route();
		expect(isValidElement(node) && node.type === SsoNoAccess).toBe(true);
		expect(h.listed).toEqual([]);
	});

	it("loading draws the upsell's box alone — no toolbar — for an org without SSO", async () => {
		h.sso = false;
		const node = await SsoLoading();
		expect(isValidElement(node) && node.type === PeopleUpsellSkeleton).toBe(true);
		expect(isValidElement<{ toolbar?: boolean }>(node) && node.props.toolbar).toBe(false);
	});

	it("loading draws the manager's shape for an entitled org", async () => {
		h.sso = true;
		const node = await SsoLoading();
		expect(isValidElement(node) && node.type === PeopleUpsellSkeleton).toBe(false);
	});
});
