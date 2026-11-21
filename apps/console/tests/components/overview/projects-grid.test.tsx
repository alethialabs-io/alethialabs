// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's project grid (#6817): one region over one read (`overview.projects`), with a
// distinct render for everything that read can answer, and live.
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
//     down says so and offers the read by hand.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
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

import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { type OverviewState, overviewProjectsInput } from "@/components/overview/overview-state";
import { ProjectsGrid } from "@/components/overview/projects-grid";
import { useOverviewProjects } from "@/components/overview/use-overview-projects";
import type { OverviewProjects } from "@/lib/rpc/procedures/overview";
import { useProjectsStore } from "@/lib/stores/use-projects-store";
import { makeGrid, makeProject } from "./project-fixture";
import { fakeOrpc, forbidden, never, reads, renderWithReads, testClient } from "./rpc-fake";

/** The pristine address: no search, no filters, cards. */
const PRISTINE: OverviewState = { q: "", clouds: [], repos: [], sort: "activity", view: "card" };

/** The grid as the page mounts it: the page's one read of it, handed to the region. */
function Grid({ state, onClearFilters }: { state: OverviewState; onClearFilters: () => void }) {
	const grid = useOverviewProjects(state);
	return <ProjectsGrid orgSlug="acme" state={state} grid={grid} onClearFilters={onClearFilters} />;
}

/** The cache key of the grid's read for `state`. */
function keyOf(state: OverviewState) {
	return fakeOrpc.overview.projects.queryKey({ input: overviewProjectsInput(state) });
}

/** Renders the grid with nothing in the cache: the read is issued and answers from `reads.grid`. */
function renderGrid(state: OverviewState = PRISTINE, onClearFilters: () => void = vi.fn()) {
	return renderWithReads(<Grid state={state} onClearFilters={onClearFilters} />);
}

/** Renders the grid with `answer` already in the cache, as the route's prefetch hands it down. */
function renderAnswered(answer: OverviewProjects, state: OverviewState = PRISTINE, onClearFilters: () => void = vi.fn()) {
	const client: QueryClient = testClient();
	client.setQueryData(keyOf(state), answer);
	return renderWithReads(<Grid state={state} onClearFilters={onClearFilters} />, client);
}

/** The hrefs of every link on screen named `name`. */
function hrefsOf(name: RegExp): (string | null)[] {
	return screen.queryAllByRole("link", { name }).map((link) => link.getAttribute("href"));
}

beforeEach(() => {
	reads.grid.mockReset();
	reads.grid.mockImplementation(never);
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

		reads.grid.mockResolvedValue(makeGrid([makeProject("p1", "payments-api")]));
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByText("payments-api")).toBeInTheDocument();
	});

	it("answered from the route's prefetch: the rows are drawn and no read is issued (B1)", () => {
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
		expect(screen.getByText("payments-api")).toBeInTheDocument();
		expect(reads.grid).not.toHaveBeenCalled();
	});
});

describe("ProjectsGrid — an organization with no project", () => {
	it("with no cloud account: says what to do in one sentence, and offers connecting one, then creating a project", () => {
		const { container } = renderAnswered(makeGrid([], { connectedProviders: [] }));
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
		renderAnswered(makeGrid([], { connectedProviders: ["aws"] }));
		expect(
			screen.getByText("Create a project to design, plan and deploy your infrastructure."),
		).toBeInTheDocument();
		expect(hrefsOf(/connect a cloud account/i)).toEqual([]);
		expect(hrefsOf(/create a project/i)).toEqual(["/acme/~/new"]);
	});

	it("when the connected accounts could not be read: it does not claim there are none", () => {
		renderAnswered(makeGrid([], { connectedProviders: null }));
		expect(hrefsOf(/connect a cloud account/i)).toEqual([]);
		expect(hrefsOf(/create a project/i)).toEqual(["/acme/~/new"]);
	});

	it("a viewer who may not create a project gets the control disabled with its reason, not a link", () => {
		const { container } = renderAnswered(makeGrid([], { canCreate: false }));
		expect(screen.getByRole("button", { name: /create a project/i })).toBeDisabled();
		expect(hrefsOf(/create a project/i)).toEqual([]);
		expect(container.textContent).toContain(MANAGE_DENIED_REASON);
	});
});

describe("ProjectsGrid — a filter that matches nothing", () => {
	it("says so, never 'No projects yet', and Clear filters resets the address", () => {
		const onClearFilters = vi.fn();
		const filtered = { ...PRISTINE, q: "zzz" };
		renderAnswered(makeGrid([], { total: 3 }), filtered, onClearFilters);
		expect(screen.getByText("No projects match your filters")).toBeInTheDocument();
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
			makeGrid([makeProject("p1", "payments-api", { status: "FAILED" })]),
			{ ...PRISTINE, view },
		);
		const badge = container.querySelector(".vx-status");
		expect(badge?.textContent).toBe("FAILED");
		expect(badge?.classList.contains("vx-status--failed")).toBe(true);
	});

	it.each(VIEWS)("links to the project's Architecture page in the %s view", (view) => {
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]), { ...PRISTINE, view });
		const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
		expect(hrefs).toContain("/acme/payments-api/architecture");
	});

	it.each(VIEWS)("a project on a cloud that is not offered says why it cannot plan or deploy, in the %s view", (view) => {
		const { container } = renderAnswered(
			makeGrid([
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
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]), { ...PRISTINE, view: "table" });
		const names = screen.getAllByRole("columnheader").map((th) => th.textContent);
		expect(names).toEqual(["Project", "Cloud", "Region", "Status", "Envs", "Add-ons", "Cost", "Last deploy", "Actions"]);
	});

	it("each project's actions menu has an accessible name", () => {
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
		expect(screen.getByRole("button", { name: "payments-api actions" })).toBeInTheDocument();
	});

	it("a starred project is listed first, for the person who starred it", () => {
		renderAnswered(makeGrid([makeProject("p1", "payments-api"), makeProject("p2", "billing-api")]));
		const order = () =>
			screen
				.getAllByRole("link", { name: /^Open / })
				.map((link) => link.getAttribute("aria-label"));
		expect(order()).toEqual(["Open payments-api", "Open billing-api"]);

		act(() => useProjectsStore.getState().toggleFavorite("u-1", "p2"));
		expect(order()).toEqual(["Open billing-api", "Open payments-api"]);

		// Somebody else's star on this browser changes nothing for this viewer.
		act(() => useProjectsStore.getState().toggleFavorite("u-1", "p2"));
		act(() => useProjectsStore.getState().toggleFavorite("u-2", "p2"));
		expect(order()).toEqual(["Open payments-api", "Open billing-api"]);
	});
});

describe("ProjectsGrid — live", () => {
	it("a project created elsewhere appears when the grid's key is invalidated, with no remount", async () => {
		const first = makeProject("p1", "payments-api");
		const { client } = renderAnswered(makeGrid([first]));
		expect(screen.queryByText("payments-copy")).not.toBeInTheDocument();

		// What a `projects` hint does (`TOPIC_KEYS`, held by tests/lib/query/overview-topic-keys.test.ts).
		reads.grid.mockResolvedValue(makeGrid([first, makeProject("p2", "payments-copy")]));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		expect(await screen.findByText("payments-copy")).toBeInTheDocument();
		expect(screen.getByText("payments-api")).toBeInTheDocument();
	});

	it("a status the console observed changing replaces the one on screen", async () => {
		const { client, container } = renderAnswered(makeGrid([makeProject("p1", "payments-api", { status: "DEPLOYING" })]));
		expect(container.querySelector(".vx-status")?.textContent).toBe("DEPLOYING");

		reads.grid.mockResolvedValue(makeGrid([makeProject("p1", "payments-api", { status: "ACTIVE" })]));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		await waitFor(() => expect(container.querySelector(".vx-status")?.textContent).toBe("ACTIVE"));
	});

	it("a refresh that fails keeps the rows, says they are the last that loaded, and its retry clears the notice", async () => {
		const { client } = renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
		reads.grid.mockRejectedValue(new Error("boom"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: fakeOrpc.overview.projects.key() });
		});
		const notice = await screen.findByRole("alert");
		expect(notice.textContent).toContain("Couldn't refresh projects");
		expect(screen.getByText("payments-api")).toBeInTheDocument();

		reads.grid.mockResolvedValue(makeGrid([makeProject("p1", "payments-api")]));
		fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});

	it("says nothing about the change stream while it is live", () => {
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
		expect(screen.queryByText(/Live updates are disconnected/)).not.toBeInTheDocument();
	});

	it("a dropped change stream says so beside the grid, and Refresh re-reads it", async () => {
		h.connection = { state: "reconnecting", hasBeenLive: true, noticeable: true };
		renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
		const notice = screen.getByRole("status");
		expect(notice.textContent).toContain("Live updates are disconnected");

		reads.grid.mockResolvedValue(makeGrid([makeProject("p1", "payments-api"), makeProject("p2", "billing-api")]));
		fireEvent.click(within(notice).getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("billing-api")).toBeInTheDocument();
		expect(reads.grid).toHaveBeenCalledTimes(1);
	});

	it("leaves a session that ended, and an address that is no longer the viewer's, to the shell", () => {
		for (const state of ["signed-out", "removed"]) {
			h.connection = { state, hasBeenLive: true, noticeable: true };
			const { unmount } = renderAnswered(makeGrid([makeProject("p1", "payments-api")]));
			expect(screen.queryByText(/Live updates are disconnected/)).not.toBeInTheDocument();
			unmount();
		}
	});
});
