// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6132 / F021: the SSO route decides its plan gate on the SERVER, as the runners (#6123), alerts
// (#6125) and teams (#6129) routes do. An org without `sso` gets the upsell as the whole body with
// no provider read prefetched, and the route's loading state draws that answer — never the
// toolbar, filter bar and provider panel the page will not render.

import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sso: false, listed: 0 }));

vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ userId: "u1", orgId: "o1" }) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ sso: h.sso }) }));
vi.mock("@/app/server/actions/sso", () => ({
	getSsoBootstrap: async () => ({ sso: h.sso, canManage: true, slug: "acme", origin: "https://c.test" }),
	listSsoProviders: async () => {
		h.listed += 1;
		return [];
	},
}));
vi.mock("@/lib/query/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query");
	return { getQueryClient: () => new QueryClient() };
});
vi.mock("@/components/settings/sso/sso-manager", () => ({ SsoManager: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: ({ feature }: { feature: string }) => <div data-upsell={feature}>upsell</div>,
}));
vi.mock("@/components/settings/members/people-skeleton", () => ({
	PeopleUpsellSkeleton: ({ toolbar }: { toolbar?: boolean }) => <div data-upsell-skeleton={String(toolbar)} />,
}));

import SsoLoading from "@/app/(private)/[org]/~/settings/sso/loading";
import SsoPage from "@/app/(private)/[org]/~/settings/sso/page";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { PeopleUpsellSkeleton } from "@/components/settings/members/people-skeleton";

/** Renders the route for org `acme`. */
function route(): Promise<ReactNode> {
	return SsoPage({ params: Promise.resolve({ org: "acme" }) });
}

beforeEach(() => {
	h.listed = 0;
});

describe("the SSO route's plan gate (F021)", () => {
	it("renders the upsell, and prefetches nothing, for an org without SSO", async () => {
		h.sso = false;
		const node = await route();
		expect(isValidElement(node) && node.type === FeatureUpsell).toBe(true);
		expect(isValidElement<{ feature: string }>(node) && node.props.feature).toBe("sso");
		expect(h.listed).toBe(0);
	});

	it("prefetches the provider list and renders the manager for an entitled org", async () => {
		h.sso = true;
		const node = await route();
		expect(isValidElement(node) && node.type === FeatureUpsell).toBe(false);
		expect(h.listed).toBe(1);
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
