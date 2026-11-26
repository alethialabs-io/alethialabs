// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's project grid (#6817, LST-4 #7486): one region over one keyset walk
// (`overview.projects.page`) and its summary (`overview.projects.summary`), with a distinct render
// for everything those reads can answer, and live.
//
// What each block holds:
//   - the read's states: pending is a skeleton and never "No projects"; a refusal is the shared
//     refused render with no retry; a failure has a retry that works;
//   - the first page a new organization sees: one sentence and the real next action — connect a
//     cloud account when none is connected, create a project either way — and a control the viewer
//     may not use is disabled with its reason;
//   - a filter that matches nothing is not "No projects yet";
//   - each project shows its status through the shared badge in BOTH views, and a project on a
//     cloud this deployment does not offer says why it cannot be planned or deployed;
//   - the grid follows its query: an invalidation (what a topic hint does) brings a new project in
//     with no remount; a refresh that fails keeps the rows and says so; a change stream that is
//     down says so and offers the read by hand;
//   - paging: the shared footer walks the server's cursor ("Load more"), says when a later page
//     failed and keeps the rows, and is gone at the end; a filter change restarts at page one;
//     nothing on screen counts the list;
//   - starred projects lead the grid whatever page they are on (asked by id), drawn once.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	connection: { state: "live", hasBeenLive: true, noticeable: false },
}));

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "u-1" }, isPending: false }),
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtimeConnection: () => h.connection }));
// The duplicate dialog's action module is a tree of server code; no test here opens the dialog.
vi.mock("@/app/server/actions/projects", () => ({ tryDuplicateProjectForProvider: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { MANAGE_DENIED_REASON, MANAGE_PENDING_REASON } from "@/components/errors/manage-gate";
import { type OverviewState, overviewProjectsInput } from "@/components/overview/overview-state";
import { ProjectsGrid } from "@/components/overview/projects-grid";
import { useOverviewProjects, useOverviewProjectsSummary } from "@/components/overview/use-overview-projects";
import type { ProjectsPage } from "@/lib/queries/projects";
import type { OverviewProjectsSummary } from "@/lib/rpc/procedures/overview";
import { useProjectsStore } from "@/lib/stores/use-projects-store";
import { makePage, makeProject, makeSummary } from "./project-fixture";
import { fakeOrpc, forbidden, never, reads, renderWithReads, testClient } from "./rpc-fake";

/** The pristine address: no search, no filters, cards. */
const PRISTINE: OverviewState = { q: "", clouds: [], repos: [], sort: "activity", view: "card" };

/** The grid as the page mounts it: the page's walk and summary, handed to the region. */
function Grid({ state, onClearFilters }: { state: OverviewState; onClearFilters: () => void }) {
	const list = useOverviewProjects(state);
	const summary = useOverviewProjectsSummary();
	return <ProjectsGrid orgSlug="acme" state={state} list={list} summary={summary} onClearFilters={onClearFilters} />;
}

/** The infinite cache key of the grid's walk for `state` — the address's query, never a cursor. */
function keyOf(state: OverviewState) {
	return [["overview", "projects", "page"], { input: overviewProjectsInput(state), type: "infinite" }];
}

/** Renders the grid with nothing in the cache: the reads are issued and answer from `reads`. */
function renderGrid(state: OverviewState = PRISTINE, onClearFilters: () => void = vi.fn()) {
	return renderWithReads(<Grid state={state} onClearFilters={onClearFilters} />);
}

/** Seeds `client` with the walk's first page and the summary, as the route's prefetch hands them down. */
function seed(client: QueryClient, page: ProjectsPage, state: OverviewState, summary: OverviewProjectsSummary | null) {
	client.setQueryData(keyOf(state), { pages: [page], pageParams: [null] });
	if (summary) client.setQueryData(fakeOrpc.overview.projects.summary.queryKey(), summary);
}

/** Renders the grid with `page` (and `summary`) already in the cache. `summary: null` leaves it pending. */
function renderAnswered(
	page: ProjectsPage,
	state: OverviewState = PRISTINE,
	onClearFilters: () => void = vi.fn(),
	summary: OverviewProjectsSummary | null = makeSummary(),
) {
	const client: QueryClient = testClient();
	seed(client, page, state, summary);
	return renderWithReads(<Grid state={state} onClearFilters={onClearFilters} />, client);
}

/** The project names on screen, in order, by their open links. */
function order(): (string | null)[] {
	return screen.getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("aria-label"));
}

/** The hrefs of every link on screen named `name`. */
function hrefsOf(name: RegExp): (string | null)[] {
	return screen.queryAllByRole("link", { name }).map((link) => link.getAttribute("href"));
}

beforeEach(() => {
	reads.grid.mockReset();
	reads.grid.mockImplementation(never);
	reads.gridSummary.mockReset();
	// A topic hint invalidates the whole `overview.projects` prefix, the summary included.
	reads.gridSummary.mockResolvedValue(makeSummary());
	h.connection = { state: "live", hasBeenLive: true, noticeable: false };
	localStorage.clear();
	useProjectsStore.setState({ favoritesByUser: {} });
});

describe("ProjectsGrid — the read's states", () => {
	it("pending: the grid's own shape, marked busy, and never the empty copy (B3)", () => {
		const { container } = renderGrid();
		expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
		expect(screen.getAllByTestId("project-card-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText(/No projects/i)).not.toBeInTheDocument();
		expect(container.querySelector("[data-slot='empty']")).toBeNull();
	});

	it("pending in the table view: rows under the table's own header, not cards", () => {
		renderGrid({ ...PRISTINE, view: "table" });
		expect(screen.getAllByTestId("project-row-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryAllByTestId("project-card-skeleton")).toHaveLength(0);
		expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
	});

	it("refused: the shared refused render, with no retry, and the refusal is not asked again", async () => {
		reads.grid.mockRejectedValue(forbidden());
		const { container } = renderGrid();
		expect(await screen.findByText("You don't have access to projects")).toBeInTheDocument();
		expect(container.querySelector("[data-state='refused']")).not.toBeNull();
		expect(container.querySelector("[data-slot='region-error']")).toBeNull();
		expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
		expect(screen.queryByText(/No projects yet/i)).not.toBeInTheDocument();
		expect(reads.grid).toHaveBeenCalledTimes(1);
	});

	it("failed: a region error whose retry loads the grid — never 'No projects yet' (B4)", async () => {
		reads.grid.mockRejectedValue(new Error("boom"));
		const { container } = renderGrid();
		expect(await screen.findByText("Couldn't load projects")).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).not.toBeNull();
		expect(screen.queryByText(/No projects yet/i)).not.toBeInTheDocument();

		reads.grid.mockResolvedValue(makePage([makeProject("p1", "payments-api")]));
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByText("payments-api")).toBeInTheDocument();
	});

	it("answered from the route's prefetch: the rows are drawn and no read is issued (B1)", () => {
		renderAnswered(makePage([makeProject("p1", "payments-api")]));
		expect(screen.getByText("payments-api")).toBeInTheDocument();
		expect(reads.grid).not.toHaveBeenCalled();
		expect(reads.gridSummary).not.toHaveBeenCalled();
	});

	it("asks the walk's first page with the address's query and no cursor", async () => {
		reads.grid.mockResolvedValue(makePage([makeProject("p1", "payments-api")]));
		renderGrid({ ...PRISTINE, q: "pay", sort: "name" });
		expect(await screen.findByText("payments-api")).toBeInTheDocument();
		expect(reads.grid).toHaveBeenCalledWith({ q: "pay", clouds: [], repos: [], sort: "name" });
	});
});

describe("ProjectsGrid — an organization with no project", () => {
	it("with no cloud account: says what to do in one sentence, and offers connecting one, then creating a project", () => {
		const { container } = renderAnswered(makePage([]), PRISTINE, vi.fn(), makeSummary({ connectedProviders: [] }));
		expect(screen.getByText("No projects yet")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Connect a cloud account, then create a project to design, plan and deploy your infrastructure in it.",
			),
		).toBeInTheDocument();
		expect(hrefsOf(/connect a cloud account/i)).toEqual(["/acme/~/connectors?type=cloud"]);
		expect(hrefsOf(/create a project/i)).toEqual(["/acme/~/new"]);
		expect(container.querySelector("[data-state='first-run']")).not.toBeNull();
	});

	it("with a cloud account connected: the one next action is creating a project", () => {
		renderAnswered(makePage([]), PRISTINE, vi.fn(), makeSummary({ connectedProviders: ["aws"] }));
		expect(
			screen.getByText("Create a project to design, plan and deploy your infrastructure."),
		).toBeInTheDocument();
		expect(hrefsOf(/connect a cloud account/i)).toEqual([]);
		expect(hrefsOf(/create a project/i)).toEqual(["/acme/~/new"]);
	});

	it("when the connected accounts could not be read: it does not claim there are none", () => {
		renderAnswered(makePage([]), PRISTINE, vi.fn(), makeSummary({ connectedProviders: null }));
		expect(hrefsOf(/connect a cloud account/i)).toEqual([]);
		expect(hrefsOf(/create a project/i)).toEqual(["/acme/~/new"]);
	});

	it("a viewer who may not create a project gets the control disabled with its reason, not a link", () => {
		const { container } = renderAnswered(makePage([]), PRISTINE, vi.fn(), makeSummary({ canCreate: false }));
		expect(screen.getByRole("button", { name: /create a project/i })).toBeDisabled();
		expect(hrefsOf(/create a project/i)).toEqual([]);
		expect(container.textContent).toContain(MANAGE_DENIED_REASON);
	});

	it("while the summary has not answered: create is disabled with the pending reason, and no cloud step is claimed", () => {
		const { container } = renderAnswered(makePage([]), PRISTINE, vi.fn(), null);
		expect(screen.getByRole("button", { name: /create a project/i })).toBeDisabled();
		expect(container.textContent).toContain(MANAGE_PENDING_REASON);
		expect(hrefsOf(/connect a cloud account/i)).toEqual([]);
	});

	it("an empty organization under a filter is still the first run, not a filter that missed", () => {
		renderAnswered(makePage([], { universeEmpty: true }), { ...PRISTINE, q: "zzz" });
		expect(screen.getByText("No projects yet")).toBeInTheDocument();
		expect(screen.queryByText("No projects match these filters.")).not.toBeInTheDocument();
	});
});

describe("ProjectsGrid — a filter that matches nothing", () => {
	it("says so, never 'No projects yet', and Clear filters resets the address", () => {
		const onClearFilters = vi.fn();
		const filtered = { ...PRISTINE, q: "zzz" };
		renderAnswered(makePage([], { universeEmpty: false }), filtered, onClearFilters);
		expect(screen.getByText("No projects match these filters.")).toBeInTheDocument();
		expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
		expect(hrefsOf(/create a project/i)).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(onClearFilters).toHaveBeenCalledTimes(1);
	});
});

describe("ProjectsGrid — what a project shows", () => {
	const VIEWS: OverviewState["view"][] = ["card", "table"];

	it.each(VIEWS)("its status, through the shared badge, in the %s view", (view) => {
		const { container } = renderAnswered(
			makePage([makeProject("p1", "payments-api", { status: "FAILED" })]),
			{ ...PRISTINE, view },
		);
		const badge = container.querySelector(".vx-status");
		expect(badge?.textContent).toBe("FAILED");
		expect(badge?.classList.contains("vx-status--failed")).toBe(true);
	});

	it.each(VIEWS)("links to the project's Architecture page in the %s view", (view) => {
		renderAnswered(makePage([makeProject("p1", "payments-api")]), { ...PRISTINE, view });
		const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
		expect(hrefs).toContain("/acme/payments-api/architecture");
	});

	it.each(VIEWS)("a project on a cloud that is not offered says why it cannot plan or deploy, in the %s view", (view) => {
		const { container } = renderAnswered(
			makePage([
				makeProject("p1", "legacy", { cloud_provider: "alibaba" }),
				makeProject("p2", "payments-api", { cloud_provider: "aws" }),
			]),
			{ ...PRISTINE, view },
		);
		const notes = [...container.querySelectorAll("[data-slot='cloud-unavailable']")].map((n) => n.textContent);
		expect(notes).toEqual([
			"Alibaba Cloud is not available in this release, so this project can't be planned or deployed.",
		]);
	});

	it("the table names its columns, the actions column included", () => {
		renderAnswered(makePage([makeProject("p1", "payments-api")]), { ...PRISTINE, view: "table" });
		const names = screen.getAllByRole("columnheader").map((th) => th.textContent);
		expect(names).toEqual(["Project", "Cloud", "Region", "Status", "Envs", "Add-ons", "Cost", "Last deploy", "Actions"]);
	});

	it("each project's actions menu has an accessible name", () => {
		renderAnswered(makePage([makeProject("p1", "payments-api")]));
		expect(screen.getByRole("button", { name: "payments-api actions" })).toBeInTheDocument();
	});

	it("a starred project is listed first, for the person who starred it", () => {
		renderAnswered(makePage([makeProject("p1", "payments-api"), makeProject("p2", "billing-api")]));
		expect(order()).toEqual(["Open payments-api", "Open billing-api"]);

		// Before the starred lookup answers (it never does here), the loaded rows are reordered.
		act(() => useProjectsStore.getState().toggleFavorite("u-1", "p2"));
		expect(order()).toEqual(["Open billing-api", "Open payments-api"]);

		// Somebody else's star on this browser changes nothing for this viewer.
		act(() => useProjectsStore.getState().toggleFavorite("u-1", "p2"));
		act(() => useProjectsStore.getState().toggleFavorite("u-2", "p2"));
		expect(order()).toEqual(["Open payments-api", "Open billing-api"]);
	});
});

describe("ProjectsGrid — starred projects on a later page", () => {
	const P3 = "00000000-0000-4000-8000-000000000003";

	it("are asked by id with the address's filters, lead the grid at once, and are drawn once", async () => {
		useProjectsStore.setState({ favoritesByUser: { "u-1": [P3] } });
		const starred = makeProject(P3, "far-away");
		reads.grid.mockImplementation(async (input) =>
			typeof input === "object" && input !== null && "ids" in input ? makePage([starred], { facets: null, universeEmpty: null }) : never(),
		);
		const state = { ...PRISTINE, clouds: ["aws"] };
		renderAnswered(makePage([makeProject("p1", "payments-api")], { nextCursor: "c1" }), state);

		expect(await screen.findByText("far-away")).toBeInTheDocument();
		expect(order()).toEqual(["Open far-away", "Open payments-api"]);
		expect(reads.grid).toHaveBeenCalledWith({ q: "", clouds: ["aws"], repos: [], sort: "activity", ids: [P3], limit: 100 });
	});

	it("a starred project the walk has also loaded is not drawn twice", async () => {
		useProjectsStore.setState({ favoritesByUser: { "u-1": [P3] } });
		const starred = makeProject(P3, "far-away");
		reads.grid.mockImplementation(async (input) =>
			typeof input === "object" && input !== null && "ids" in input ? makePage([starred], { facets: null, universeEmpty: null }) : never(),
		);
		renderAnswered(makePage([makeProject("p1", "payments-api"), starred]));
		await waitFor(() => expect(reads.grid).toHaveBeenCalled());
		await waitFor(() => expect(order()).toEqual(["Open far-away", "Open payments-api"]));
	});
});

describe("ProjectsGrid — paging", () => {
	const projects = Array.from({ length: 5 }, (_, i) => makeProject(`p${i}`, `proj-${i}`));

	it("Load more asks the next page with the server's cursor and appends it, keeping the first page's facets", async () => {
		reads.grid.mockResolvedValue(makePage(projects.slice(2), { facets: null, universeEmpty: null }));
		renderAnswered(makePage(projects.slice(0, 2), { nextCursor: "cursor-2" }));
		expect(order()).toEqual(["Open proj-0", "Open proj-1"]);

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await waitFor(() => expect(order()).toHaveLength(5));
		expect(order()).toEqual(["Open proj-0", "Open proj-1", "Open proj-2", "Open proj-3", "Open proj-4"]);
		expect(reads.grid).toHaveBeenCalledWith({ q: "", clouds: [], repos: [], sort: "activity", cursor: "cursor-2" });
		// The last page said so: the footer is gone, and nothing says "That's all".
		expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
	});

	it("while a later page loads, the button stays, disabled and busy", async () => {
		reads.grid.mockImplementation(never);
		const { container } = renderAnswered(makePage(projects.slice(0, 2), { nextCursor: "cursor-2" }));
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await waitFor(() => expect(container.querySelector("[data-slot='list-footer'][data-state='loading']")).not.toBeNull());
		expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
	});

	it("a failed later page keeps every loaded row and offers to try again — not a region error", async () => {
		reads.grid.mockRejectedValue(new Error("boom"));
		const { container } = renderAnswered(makePage(projects.slice(0, 2), { nextCursor: "cursor-2" }));
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Couldn't load more", undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(order()).toEqual(["Open proj-0", "Open proj-1"]);
		expect(container.querySelector("[data-slot='region-error']")).toBeNull();
		expect(screen.queryByText("Couldn't refresh projects. This is the last list that loaded.")).not.toBeInTheDocument();

		reads.grid.mockResolvedValue(makePage(projects.slice(2), { facets: null, universeEmpty: null }));
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(order()).toHaveLength(5));
	}, 10_000);

	it("a filter change restarts the walk at page one: the new key is asked with no cursor", async () => {
		const client = testClient();
		seed(client, makePage(projects.slice(0, 2), { nextCursor: "cursor-2" }), PRISTINE, makeSummary());
		const { rerender } = renderWithReads(<Grid state={PRISTINE} onClearFilters={vi.fn()} />, client);
		reads.grid.mockResolvedValue(makePage([makeProject("p9", "shop-api")]));

		rerender(
			<QueryClientProvider client={client}>
				<Grid state={{ ...PRISTINE, q: "shop" }} onClearFilters={vi.fn()} />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("shop-api")).toBeInTheDocument();
		expect(reads.grid).toHaveBeenCalledTimes(1);
		expect(reads.grid).toHaveBeenCalledWith({ q: "shop", clouds: [], repos: [], sort: "activity" });
	});

	it("nothing on screen counts the list", () => {
		const { container } = renderAnswered(makePage(projects.slice(0, 2), { nextCursor: "cursor-2" }));
		expect(container.textContent).not.toMatch(/\d+\s+(of|total)\b|Showing|Show \d+ more/i);
	});
});

describe("ProjectsGrid — live", () => {
	it("a project created elsewhere appears when the grid's key is invalidated, with no remount", async () => {
		const first = makeProject("p1", "payments-api");
		const { client } = renderAnswered(makePage([first]));
		expect(screen.queryByText("payments-copy")).not.toBeInTheDocument();

		// What a `projects` hint does (`TOPIC_KEYS`, held by tests/lib/query/overview-topic-keys.test.ts).
		reads.grid.mockResolvedValue(makePage([first, makeProject("p2", "payments-copy")]));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		expect(await screen.findByText("payments-copy")).toBeInTheDocument();
		expect(screen.getByText("payments-api")).toBeInTheDocument();
	});

	it("a status the console observed changing replaces the one on screen", async () => {
		const { client, container } = renderAnswered(makePage([makeProject("p1", "payments-api", { status: "DEPLOYING" })]));
		expect(container.querySelector(".vx-status")?.textContent).toBe("DEPLOYING");

		reads.grid.mockResolvedValue(makePage([makeProject("p1", "payments-api", { status: "ACTIVE" })]));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		await waitFor(() => expect(container.querySelector(".vx-status")?.textContent).toBe("ACTIVE"));
	});

	it("a refresh that fails keeps the rows, says they are the last that loaded, and its retry clears the notice", async () => {
		const { client } = renderAnswered(makePage([makeProject("p1", "payments-api")]));
		reads.grid.mockRejectedValue(new Error("boom"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		const notice = await screen.findByRole("alert");
		expect(notice.textContent).toContain("Couldn't refresh projects");
		expect(screen.getByText("payments-api")).toBeInTheDocument();

		reads.grid.mockResolvedValue(makePage([makeProject("p1", "payments-api")]));
		fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});

	it("says nothing about the change stream while it is live", () => {
		renderAnswered(makePage([makeProject("p1", "payments-api")]));
		expect(screen.queryByText(/Live updates are disconnected/)).not.toBeInTheDocument();
	});

	it("a dropped change stream says so beside the grid, and Refresh re-reads it", async () => {
		h.connection = { state: "reconnecting", hasBeenLive: true, noticeable: true };
		renderAnswered(makePage([makeProject("p1", "payments-api")]));
		const notice = screen.getByRole("status");
		expect(notice.textContent).toContain("Live updates are disconnected");

		reads.grid.mockResolvedValue(makePage([makeProject("p1", "payments-api"), makeProject("p2", "billing-api")]));
		fireEvent.click(within(notice).getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("billing-api")).toBeInTheDocument();
		expect(reads.grid).toHaveBeenCalledTimes(1);
	});

	it("leaves a session that ended, and an address that is no longer the viewer's, to the shell", () => {
		for (const state of ["signed-out", "removed"]) {
			h.connection = { state, hasBeenLive: true, noticeable: true };
			const { unmount } = renderAnswered(makePage([makeProject("p1", "payments-api")]));
			expect(screen.queryByText(/Live updates are disconnected/)).not.toBeInTheDocument();
			unmount();
		}
	});
});
