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
import { act, render } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	sso: false,
	refuse: false,
	fail: false,
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
				if (h.fail) throw new Error("database unavailable");
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
	PeopleListSkeleton: () => <div data-list-skeleton />,
}));

import SsoLoading from "@/app/(private)/[org]/~/settings/sso/loading";
import SsoPage from "@/app/(private)/[org]/~/settings/sso/page";
import { SsoNoAccess } from "@/components/settings/sso/sso-no-access";
import { SsoReadFailed } from "@/components/settings/sso/sso-read-failed";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

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
	h.fail = false;
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

	// R6 E-21: a FAILED bootstrap (not a refusal) is the page's own region error with a retry, as
	// every other people & access page renders a failed read — not a throw to the route boundary.
	it("renders its own read-failed state, and prefetches nothing, when the bootstrap fails", async () => {
		h.sso = true;
		h.fail = true;
		const node = await route();
		expect(isValidElement(node) && node.type === SsoReadFailed).toBe(true);
		expect(h.listed).toEqual([]);
	});

	// R6 E-22: the entitled skeleton has the manager's shape — the provider rail beside the detail
	// pane, and the SCIM card under them — not one plain panel.
	it("loading draws the rail-and-pane split and the SCIM card for an entitled org", () => {
		act(() => useWorkspaceStore.setState({ entitlements: { ...COMMUNITY_ENTITLEMENTS, sso: true } }));
		const { container } = render(<SsoLoading />);
		const root = container.querySelector('[data-slot="skeleton-root"]');
		expect(root?.querySelector(".lg\\:grid-cols-\\[280px_1fr\\]")).not.toBeNull();
		expect(root?.querySelector("[data-slot=\"sso-scim-skeleton\"]")).not.toBeNull();
	});

	// The loading state is SYNCHRONOUS (CON-M4): it keys on the workspace store's plan, and while that
	// is not yet known it draws the entitled shape rather than wait for the actor.
	it("loading draws the upsell's box alone — no toolbar — for an org known not to have SSO", () => {
		act(() => useWorkspaceStore.setState({ entitlements: { ...COMMUNITY_ENTITLEMENTS, sso: false } }));
		const { container } = render(<SsoLoading />);
		expect(container.querySelector('[data-upsell-skeleton="false"]')).not.toBeNull();
		expect(container.querySelector('[data-slot="skeleton-root"]')).toBeNull();
	});

	it.each([
		["an entitled org", true],
		["an org whose plan is not known yet", null],
	] as const)("loading draws the manager's shape for %s", (_label, sso) => {
		act(() =>
			useWorkspaceStore.setState({
				entitlements: sso === null ? null : { ...COMMUNITY_ENTITLEMENTS, sso },
			}),
		);
		const { container } = render(<SsoLoading />);
		expect(container.querySelector("[data-upsell-skeleton]")).toBeNull();
		expect(container.querySelector('[data-slot="skeleton-root"]')).not.toBeNull();
	});
});
