// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6123 / F021: the runners route decides its plan gate on the SERVER, before anything that looks
// like the page renders, and its loading state promises nothing it cannot know.
//
// Before: `loading.tsx` drew the runner grid's skeleton, the client then learned the entitlement from
// the workspace store and swapped in the upsell — a skeleton that promised content that never came.
// Now the route reads the actor's entitlements (resolved from the ADDRESS), renders the upsell with no
// prefetch for a hosted plan without BYO runners, and the grid skeleton is only the fallback of the
// part that renders once the gate has said the grid is coming.

import { render } from "@testing-library/react";
import { isValidElement, type ReactNode, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	mode: "hosted" as "hosted" | "self-managed",
	byoRunners: false,
	prefetched: [] as string[],
}));

vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ userId: "u1", orgId: "o1" }) }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ byoRunners: h.byoRunners }) }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: () => h.mode }));
vi.mock("@/lib/rpc/server", () => {
	/** A procedure stand-in whose queryOptions records which read was prefetched. */
	const proc = (name: string) => ({
		queryOptions: (opts?: { input?: unknown }) => ({
			queryKey: [name, opts?.input ?? null],
			queryFn: async () => {
				h.prefetched.push(name);
				return {};
			},
		}),
	});
	const rpc = { runners: { page: proc("runners.page"), list: proc("runners.list"), fleet: proc("runners.fleet") } };
	return { serverOrpc: () => rpc };
});
// A fresh client per route call — the browser singleton would carry one test's prefetches into the next.
vi.mock("@/lib/query/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query");
	return { getQueryClient: () => new QueryClient() };
});
vi.mock("@/app/(private)/[org]/~/runners/runners-client", () => ({ RunnersClient: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: ({ feature }: { feature: string }) => <div data-upsell={feature}>upsell</div>,
}));
vi.mock("@/components/runners/runners-skeleton", () => ({
	RunnersSkeleton: ({ hosted }: { hosted: boolean }) => <div data-skeleton={hosted ? "hosted" : "self"} />,
}));

import RunnersLoading from "@/app/(private)/[org]/~/runners/loading";
import RunnersRoute from "@/app/(private)/[org]/~/runners/page";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { RunnersSkeleton } from "@/components/runners/runners-skeleton";

/** Renders the route for a pristine link; also renders its async prefetching part, if any. */
async function route(): Promise<ReactNode> {
	const node = await RunnersRoute({ searchParams: Promise.resolve({}) });
	if (isValidElement<{ children?: ReactNode }>(node) && node.type === Suspense) {
		const child = node.props.children;
		// The prefetching part is an async server component: a plain function of its props.
		if (isValidElement(child) && typeof child.type === "function") await Reflect.apply(child.type, undefined, [child.props]);
	}
	return node;
}

beforeEach(() => {
	h.prefetched = [];
});

describe("the runners route's plan gate (F021)", () => {
	it("a hosted plan without BYO runners gets the upsell and NOTHING is prefetched", async () => {
		h.mode = "hosted";
		h.byoRunners = false;
		const node = await route();
		expect(isValidElement(node) && node.type).toBe(FeatureUpsell);
		expect(isValidElement<{ feature: string }>(node) && node.props.feature).toBe("byoRunners");
		expect(h.prefetched).toEqual([]);
	});

	it("an entitled hosted tenant gets the grid's skeleton as the fallback, and no pools read", async () => {
		h.mode = "hosted";
		h.byoRunners = true;
		const node = await route();
		expect(isValidElement(node) && node.type).toBe(Suspense);
		const fallback = isValidElement<{ fallback: ReactNode }>(node) ? node.props.fallback : null;
		expect(isValidElement<{ hosted: boolean }>(fallback) && fallback.type === RunnersSkeleton && fallback.props.hosted).toBe(
			true,
		);
		expect(h.prefetched.sort()).toEqual(["runners.list", "runners.page"]);
	});

	it("a self-managed operator is never gated, and the Pools column's read is prefetched", async () => {
		h.mode = "self-managed";
		h.byoRunners = false;
		const node = await route();
		expect(isValidElement(node) && node.type).toBe(Suspense);
		expect(h.prefetched.sort()).toEqual(["runners.fleet", "runners.list", "runners.page"]);
	});
});

describe("loading.tsx — shown before the gate is known", () => {
	it("promises no shape: no skeleton, no grid, no table — only a busy region", () => {
		const { container } = render(<RunnersLoading />);
		expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
		expect(container.querySelector("table, [role=table], [role=grid]")).toBeNull();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.textContent).toBe("Loading runners");
	});
});
