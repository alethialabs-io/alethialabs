// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview must hydrate the server's HTML for a browser that has starred projects (#5840).
//
// Favourites are per-browser: `useProjectsStore` persists them to sessionStorage, and zustand's
// `persist` loads them into the store when the store is created. The server has no sessionStorage,
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
// sessionStorage and loads them through the store's own `persist`, as a page load does, hydrates
// the server's HTML, and asserts React reported nothing and the starred project is first once
// hydration is over.
//
// Mutation check (done when this was written): making `overview-client.tsx` read the ids with
// `useProjectsStore.getState().favoriteProjectIds` — the live state, bypassing the server snapshot —
// fails both tests with "Hydration failed because the server rendered text didn't match the
// client" in `recoverable`.

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

import { OverviewClient, type OverviewState } from "@/app/(private)/[org]/overview-client";
import { useProjectsStore } from "@/lib/stores/use-projects-store";

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

/** The overview as `page.tsx` renders it for `PROJECTS`, in the given view. */
function overview(view: OverviewState["view"]) {
	return (
		<OverviewClient
			orgSlug="acme"
			projects={PROJECTS}
			facets={{ clouds: [], repos: [] }}
			state={{ ...STATE, view }}
			totalCount={PROJECTS.length}
			connectedProviders={[]}
		/>
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
 * this browser does — from sessionStorage, through the store's own `persist` — and hydrate the
 * server's HTML. Hydration runs inside `act`, so the re-render that follows it has committed.
 */
async function serverThenHydrate(
	view: OverviewState["view"],
	favourites: string[],
): Promise<{ serverHtml: string; recoverable: unknown[] }> {
	const serverHtml = renderToString(overview(view));

	sessionStorage.setItem(
		"projects-store",
		JSON.stringify({ state: { favoriteProjectIds: favourites }, version: 1 }),
	);
	await useProjectsStore.persist.rehydrate();

	container = document.createElement("div");
	container.innerHTML = serverHtml;
	document.body.appendChild(container);
	const recoverable: unknown[] = [];
	const target = container;
	await act(async () => {
		root = hydrateRoot(target, overview(view), {
			onRecoverableError: (error) => recoverable.push(error),
		});
	});
	return { serverHtml, recoverable };
}

beforeEach(() => {
	sessionStorage.clear();
	useProjectsStore.setState({ favoriteProjectIds: [] });
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
		expect(useProjectsStore.getState().favoriteProjectIds).toEqual(["p-beta"]);

		expect(recoverable).toEqual([]);
		// Once hydration is over, the starred project floats to the top.
		expect(onScreenOrder(container ?? document)).toEqual(["billing-api", "payments-api"]);
	});
});
