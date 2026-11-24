// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview must hydrate the server's HTML for a browser that has starred projects (#5840).
//
// Favourites are per-browser and per-person: `useProjectsStore` persists them to localStorage, keyed
// by the signed-in person (#6817), and zustand's `persist` loads them into the store when the store
// is created. The server has no localStorage,
// so it renders the projects in the server's order with nothing starred, while the browser's store
// already holds the starred ids when React hydrates. Rendering those ids during hydration floats a
// starred project to the top, the list disagrees with the server's, and React reports #418 and
// throws the page's server HTML away. #5830 made streamed boundaries hydrate rather than
// client-render, which is what would make that reachable; the release gate's audit leg cannot see
// it because it signs in to an org with no projects.
//
// WHAT KEEPS IT FROM HAPPENING TODAY is not code in this repo. zustand 5's hook reads the store
// through `useSyncExternalStore` with `getInitialState` as the SERVER snapshot, which React uses
// for the server render and for hydration; `persist` sets `getInitialState` to the state BEFORE
// storage was read. So a component that reads favourites through `useProjectsStore(...)` renders
// "none starred" while hydrating, and React re-renders with the stored ids straight after. This
// test is what holds that in place — against a zustand upgrade that changes either half, and
// against a component that reads the ids some other way.
//
// The test renders the overview on the "server" with an empty store, then puts favourites in
// localStorage and loads them through the store's own `persist`, as a page load does, hydrates
// the server's HTML, and asserts React reported nothing and the starred project is first once
// hydration is over.
//
// Mutation check (done when this was written, against the component that read the ids then): reading
// them with `useProjectsStore.getState()` — the live state, bypassing the server snapshot —
// fails both tests with "Hydration failed because the server rendered text didn't match the
// client" in `recoverable`.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { projectHref } from "@/lib/routing";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme",
	useSearchParams: () => new URLSearchParams(),
}));

// The overview's other children read queries and server actions; none of them reads favourites,
// and #5830's own test covers the one that hydrates a shared query (`RecentJobsCard`).
vi.mock("@/components/overview/overview-toolbar", () => ({ OverviewToolbar: () => null }));
vi.mock("@/components/overview/usage-card", () => ({ UsageCard: () => null }));
vi.mock("@/components/overview/alerts-card", () => ({ AlertsCard: () => null }));
vi.mock("@/components/overview/recent-jobs-card", () => ({ RecentJobsCard: () => null }));

// The grid is a keyset walk now (#6817, LST-4 #7486): the fake transport gives it the browser's real
// key, and the test seeds the first page as the route's prefetch and hydration would.
vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./overview/rpc-fake")).fakeOrpc }));
// The signed-in person the stars belong to, as the private layout seeds it.
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "u-1" }, isPending: false }),
}));
// The duplicate dialog's action module is a tree of server code; no test here opens the dialog.
vi.mock("@/app/server/actions/projects", () => ({ tryDuplicateProjectForProvider: vi.fn() }));

import { OverviewClient } from "@/app/(private)/[org]/overview-client";
import { type OverviewState, overviewProjectsInput } from "@/components/overview/overview-state";
import { PROJECTS_FAVORITES_STORAGE_KEY, useProjectsStore } from "@/lib/stores/use-projects-store";
import { fakeOrpc, never, reads } from "./overview/rpc-fake";

/** The person signed in to this browser. */
const USER = "u-1";

/** One overview row, named `name`; every other field is a fixed, plausible value. */
function project(id: string, name: string): ProjectListItem {
	const at = new Date("2026-10-01T00:00:00.000Z");
	return {
		id,
		user_id: "00000000-0000-4000-8000-000000000001",
		org_id: "00000000-0000-4000-8000-000000000002",
		cloud_identity_id: null,
		project_name: name,
		slug: name,
		region: "eu-central-1",
		iac_version: "1",
		estimated_monthly_cost: null,
		webhook_ca_consumers: [],
		created_at: at,
		updated_at: at,
		cloud_provider: "aws",
		environment_stage: "production",
		status: "ready",
		default_environment_id: null,
		repositories: [],
		services_count: 0,
		addons_count: 0,
		environments_count: 1,
		last_deployed_at: null,
	};
}

/** The server's order: activity, most recent first. `billing-api` is the one the browser starred. */
const PROJECTS = [project("p-alpha", "payments-api"), project("p-beta", "billing-api")];

/** The pristine overview state — no search, no filters, the card view. */
const STATE: OverviewState = { q: "", clouds: [], repos: [], sort: "activity", view: "card" };

/** Both of the overview's views: the cards and the table each render the favourite. */
const VIEWS: OverviewState["view"][] = ["card", "table"];

/** The grid's first (and only) keyset page for `PROJECTS`, as `overview.projects.page` gives it. */
const PAGE = { rows: PROJECTS, nextCursor: null, facets: { clouds: [], repos: [] }, universeEmpty: false };

/** The grid's summary, as `overview.projects.summary` gives it. */
const SUMMARY = { projectCount: PROJECTS.length, connectedProviders: [], offeredClouds: ["aws"], canCreate: true };

/**
 * A cache holding the grid's first page (its INFINITE key: the address's query, never a cursor) and
 * its summary for `state`, as the page's hydration boundary leaves them. The starred-projects lookup
 * is NOT seeded — the route cannot know the browser's stars — so after hydration the grid orders the
 * loaded rows while that read is in flight; its transport never answers here.
 */
function seededClient(state: OverviewState): QueryClient {
	const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
	client.setQueryData([["overview", "projects", "page"], { input: overviewProjectsInput(state), type: "infinite" }], {
		pages: [PAGE],
		pageParams: [null],
	});
	client.setQueryData(fakeOrpc.overview.projects.summary.queryKey(), SUMMARY);
	return client;
}

/** The overview as `page.tsx` renders it for `PROJECTS`, in the given view. */
function overview(view: OverviewState["view"], client: QueryClient) {
	const state = { ...STATE, view };
	return (
		<QueryClientProvider client={client}>
			<OverviewClient orgSlug="acme" state={state} />
		</QueryClientProvider>
	);
}

/** The project names in the order they are on screen — each card and row links to its project. */
function onScreenOrder(root: ParentNode): string[] {
	const names: string[] = [];
	for (const a of root.querySelectorAll("a[href]")) {
		const href = a.getAttribute("href") ?? "";
		const hit = PROJECTS.find((p) => p.slug !== null && href === projectHref("acme", p.slug));
		if (hit && !names.includes(hit.project_name)) names.push(hit.project_name);
	}
	return names;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/**
 * Server-render the overview with no favourites, then load `favourites` the way a page load in
 * this browser does — from localStorage, through the store's own `persist` — and hydrate the
 * server's HTML. Hydration runs inside `act`, so the re-render that follows it has committed.
 */
async function serverThenHydrate(
	view: OverviewState["view"],
	favourites: string[],
): Promise<{ serverHtml: string; recoverable: unknown[] }> {
	const serverHtml = renderToString(overview(view, seededClient({ ...STATE, view })));

	localStorage.setItem(
		PROJECTS_FAVORITES_STORAGE_KEY,
		JSON.stringify({ state: { favoritesByUser: { [USER]: favourites } }, version: 1 }),
	);
	await useProjectsStore.persist.rehydrate();

	container = document.createElement("div");
	container.innerHTML = serverHtml;
	document.body.appendChild(container);
	const recoverable: unknown[] = [];
	const target = container;
	await act(async () => {
		root = hydrateRoot(target, overview(view, seededClient({ ...STATE, view })), {
			onRecoverableError: (error) => recoverable.push(error),
		});
	});
	return { serverHtml, recoverable };
}

beforeEach(() => {
	reads.grid.mockReset();
	reads.grid.mockImplementation(never);
	localStorage.clear();
	useProjectsStore.setState({ favoritesByUser: {} });
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
});

describe("the overview hydrates cleanly for a browser with starred projects (#5840)", () => {
	it.each(VIEWS)("in the %s view", async (view) => {
		const { serverHtml, recoverable } = await serverThenHydrate(view, ["p-beta"]);

		// The fixture is doing its job only if the server put the starred project second.
		const server = document.createElement("div");
		server.innerHTML = serverHtml;
		expect(onScreenOrder(server)).toEqual(["payments-api", "billing-api"]);
		expect(useProjectsStore.getState().favoritesByUser[USER]).toEqual(["p-beta"]);

		expect(recoverable).toEqual([]);
		// Once hydration is over, the starred project floats to the top.
		expect(onScreenOrder(container ?? document)).toEqual(["billing-api", "payments-api"]);
	});
});
