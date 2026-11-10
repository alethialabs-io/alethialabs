// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell paints the org the ADDRESS is on from the layout's seed, not a default (F002, #6114).
//
// The `[org]` layout prefetches `workspace.context` and hydrates it. These tests stand in for that
// hydration by seeding a QueryClient with exactly that key, then render the REAL switcher and store
// with `renderToString` — the server render, which is also what the first client paint must equal.
// Before #6114 the switcher read a store only a client fetch filled, so this markup said "Personal"
// and the community plan on every hard load. The read router's client is replaced by a spy that
// fails the test if anything fetches: a seeded shell must not ask.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "@/lib/rpc/procedures/workspace";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/jobs",
}));
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));
const { readContext } = vi.hoisted(() => ({ readContext: vi.fn() }));
vi.mock("@/lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rpc/client")>()),
	rpcClient: { workspace: { context: readContext } },
}));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));

import { OrgSwitcher } from "@/components/org-switcher";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { orpc } from "@/lib/rpc/client";
import { useWorkspaceStore, useWorkspaceStoreSync } from "@/lib/stores/use-workspace-store";

/** The context the layout prefetches for `/acme/…`: the user is in Acme (Team) and Beta. */
const CONTEXT: WorkspaceContext = {
	activeOrgId: "org-acme",
	organizations: [
		{ id: "org-beta", name: "Beta", slug: "beta", logo: null, role: "owner", plan: "community", status: "none" },
		{ id: "org-acme", name: "Acme", slug: "acme", logo: null, role: "admin", plan: "team", status: "active" },
	],
	entitlements: { ...COMMUNITY_ENTITLEMENTS, byoRunners: true },
	isHosted: true,
};

/** A client holding what the layout's HydrationBoundary hands down, or nothing at all. */
function client(seeded: boolean): QueryClient {
	const c = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
	if (seeded) c.setQueryData(orpc.workspace.context.queryKey(), CONTEXT);
	return c;
}

/** `node` under a QueryClientProvider for `c`. */
function within(c: QueryClient, node: ReactNode): ReactNode {
	return <QueryClientProvider client={c}>{node}</QueryClientProvider>;
}

beforeEach(() => {
	readContext.mockReset();
	readContext.mockRejectedValue(new Error("a seeded shell must not fetch the workspace"));
	useWorkspaceStore.setState({
		activeOrgId: null,
		organizations: [],
		entitlements: null,
		isHosted: false,
		loadStatus: "idle",
		isLoading: false,
	});
});

describe("the org switcher on first paint (F002)", () => {
	it("names the addressed org and its plan from the seed — never \"Personal\"", () => {
		const html = renderToString(within(client(true), <OrgSwitcher />));
		expect(html).toContain("Acme");
		expect(html).toContain(">Pro<"); // the `team` plan's display name
		expect(html).not.toContain("Personal");
		expect(html).not.toContain("Hobby"); // the community plan's display name
		expect(readContext).not.toHaveBeenCalled();
	});

	it("picks the org by the ADDRESS's slug, not by list order", () => {
		// Beta is first in the list; the address is /acme.
		const html = renderToString(within(client(true), <OrgSwitcher />));
		expect(html).not.toContain(">Beta<");
	});

	it("without a seed, names the org by its address and claims no plan", () => {
		const html = renderToString(within(client(false), <OrgSwitcher />));
		expect(html).toContain("acme");
		expect(html).not.toContain("Personal");
		expect(html).not.toContain("Hobby"); // the community plan's display name
	});
});

describe("the workspace store settles from the hydrated context", () => {
	/** Mounts the shell's sync hook alone. */
	function Sync(): null {
		useWorkspaceStoreSync();
		return null;
	}

	it("is loaded with the seed's entitlements after mount, with no request", async () => {
		await act(async () => {
			render(within(client(true), <Sync />));
		});
		const state = useWorkspaceStore.getState();
		expect(state.loadStatus).toBe("loaded");
		expect(state.activeOrgId).toBe("org-acme");
		expect(state.entitlements?.byoRunners).toBe(true);
		expect(readContext).not.toHaveBeenCalled();
	});
});
