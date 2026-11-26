// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6121 — the jobs list renders FOUR distinct answers (RUBRIC B4): a refusal, a failed read, an
// org with no jobs, and rows. None may stand in for another: a failure rendered as "No jobs yet"
// tells the user something false about their data. And each row is a real link (F025).
//
// #7483 — the list pages through the keyset contract: `useKeysetList` (mocked here at its seam, so
// each state is set directly) + `<DataTable keyset>` + `ListFooter`. No count pill, no "N of M".
// The hook's own paging, restart and live-refetch behaviour is tests/components/jobs/jobs-list-paging.test.tsx.

import { ORPCError } from "@orpc/client";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The list's state, and the query the list last asked `useKeysetList` with.
const page = vi.hoisted((): { current: Record<string, unknown>; input: Record<string, unknown> } => ({
	current: {},
	input: {},
}));
const route = vi.hoisted((): { params: Record<string, string> } => ({ params: { org: "acme" } }));
vi.mock("@/lib/query/use-keyset-list", () => ({
	useKeysetList: (_procedure: unknown, input: Record<string, unknown>) => {
		page.input = input;
		return page.current;
	},
}));
vi.mock("@/lib/query/use-activity-query", () => ({ useMembersQuery: () => ({ data: [], isPending: false }) }));
vi.mock("next/navigation", () => ({
	useParams: () => route.params,
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/jobs",
	useSearchParams: () => new URLSearchParams(),
}));

import { JobsClient } from "@/app/(private)/[org]/~/jobs/jobs-client";
import { DEFAULT_JOBS_FILTERS } from "@/components/jobs/jobs-query";
import { useJobsFilters } from "@/lib/stores/use-jobs-filters";

const EMPTY_FACETS = { authors: [], envs: [], projects: [], statuses: [], types: [] };
const JOB = {
	id: "11111111-1111-4111-8111-111111111111",
	job_type: "PLAN",
	status: "SUCCESS",
	created_at: "2026-10-20T10:00:00.000Z",
	completed_at: "2026-10-20T10:01:00.000Z",
	error_message: null,
	user_id: null,
	project_id: null,
	project_name: null,
	project_slug: null,
	runner_id: null,
	runner_name: null,
	runner_version: null,
	cloud_provider: null,
	cloud_identity_status: null,
	environment_name: null,
	environment_stage: null,
};

/**
 * A `useKeysetList` result. `first` is the first page's query state (`list.query`); the rest are the
 * list's own fields. Defaults: settled, nothing loaded, no further page.
 */
function list(state: Record<string, unknown> = {}, first: Record<string, unknown> = {}) {
	return {
		rows: [],
		facets: null,
		universeEmpty: null,
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: vi.fn(),
		...state,
		query: { isLoading: false, isError: false, data: undefined, error: null, refetch: vi.fn(), ...first },
	};
}

/** A landed first page holding `rows`; `universeEmpty` says whether the SCOPE holds any job at all. */
function answered(rows: unknown[], extra: Record<string, unknown> = {}, first: Record<string, unknown> = {}) {
	return list(
		{ rows, facets: EMPTY_FACETS, universeEmpty: rows.length === 0, ...extra },
		{ data: { pages: [{ rows }] }, ...first },
	);
}

beforeEach(() => {
	page.current = list({ isPending: true }, { isLoading: true });
	page.input = {};
	route.params = { org: "acme" };
	useJobsFilters.setState({ filters: DEFAULT_JOBS_FILTERS });
});

describe("the jobs list's four answers", () => {
	it("a refusal renders as a refusal — not an error, not an empty org", () => {
		page.current = list({}, { isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) });
		const { container } = render(<JobsClient />);
		// The shared refusal render and wording (components/errors/region-refusal.tsx), no retry.
		expect(screen.getByText("You don't have access to jobs")).toBeInTheDocument();
		expect(container.querySelector('[data-state="refused"][data-refusal="forbidden"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("No jobs yet")).toBeNull();
	});

	it("a failed read renders as a region error with a retry — never as an empty org", () => {
		page.current = list({}, { isError: true, error: new Error("network") });
		render(<JobsClient />);
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load jobs");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText("No jobs yet")).toBeNull();
	});

	it("an org with no jobs renders its onboarding empty state", () => {
		page.current = answered([]);
		render(<JobsClient />);
		expect(screen.getByText("No jobs yet")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("a pending read shows neither the empty state nor 'No results.'", () => {
		page.current = list({ isPending: true }, { isLoading: true });
		render(<JobsClient />);
		expect(screen.queryByText("No jobs yet")).toBeNull();
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("rows render, each with a real link to its job", () => {
		page.current = answered([JOB]);
		render(<JobsClient />);
		const link = screen.getByRole("link", { name: /plan/i });
		expect(link).toHaveAttribute("href", `/acme/~/jobs/${JOB.id}`);
	});

	it("a failed REFRESH behind rows keeps the rows (the table's stale notice), not a region error", () => {
		page.current = answered([JOB], {}, { isError: true, error: new Error("network") });
		render(<JobsClient />);
		expect(screen.getByRole("link", { name: /plan/i })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load jobs")).toBeNull();
	});
});

describe("an empty list says which kind of empty it is", () => {
	it("an org with no jobs offers to create a project", () => {
		page.current = answered([]);
		render(<JobsClient />);
		expect(screen.getByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Create a project" })).toHaveAttribute("href", "/acme/~/new");
	});

	// D-04: a new project in an org that HAS jobs used to read "No jobs match these filters" with a
	// Clear button that did nothing, because the project was a filter and the total was the org's.
	it("a project with no jobs yet gets its own first-run state, pointing at its Architecture", () => {
		route.params = { org: "acme", project: "payments" };
		page.current = answered([]);
		render(<JobsClient projectId="proj-1" />);
		expect(screen.getByRole("heading", { name: "No jobs for this project yet" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open Architecture" })).toHaveAttribute(
			"href",
			"/acme/payments/architecture",
		);
		expect(screen.queryByText("No jobs match these filters.")).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});

	it("jobs that exist but are all filtered out say so, and Clear filters resets every filter — the range too", () => {
		// The scope holds jobs (universeEmpty false); the filters exclude every one of them.
		page.current = answered([], { universeEmpty: false });
		render(<JobsClient />);
		// After the mount: the link replaces the store when the page mounts (a bare link is the
		// pristine list), so a selection made before it would not survive to be cleared.
		act(() => useJobsFilters.getState().patch({ statuses: ["FAILED"], range: "7d" }));
		expect(useJobsFilters.getState().filters.range).toBe("7d");
		expect(screen.getByRole("heading", { name: "No jobs match these filters." })).toBeInTheDocument();
		expect(screen.queryByText("No jobs yet")).toBeNull();
		// The toolbar names the selection on its facet, and counts both filters in its reset.
		expect(screen.getByRole("button", { name: "Status: Failed" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset · 2" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useJobsFilters.getState().filters).toEqual(DEFAULT_JOBS_FILTERS);
	});
});

describe("what the list asks the read for", () => {
	it("a project's list sends the project as its scope, never as a Project filter", () => {
		route.params = { org: "acme", project: "payments" };
		page.current = answered([JOB]);
		render(<JobsClient projectId="proj-1" />);
		act(() => useJobsFilters.getState().set("projects", ["some-other-project"]));
		expect(page.input.projectId).toBe("proj-1");
		expect(page.input.projects).toBeUndefined();
	});

	it("the org list sends no scope", () => {
		page.current = answered([JOB]);
		render(<JobsClient />);
		expect(page.input).toEqual({ range: { preset: "12mo" } });
		// The page size and the cursor are never part of the list's query (the cursor is the page param).
		expect(page.input).not.toHaveProperty("limit");
		expect(page.input).not.toHaveProperty("cursor");
	});

	it("the date range is a filter like the rest: a picked preset reaches the read unresolved", () => {
		page.current = answered([JOB]);
		render(<JobsClient />);
		act(() => useJobsFilters.getState().set("range", "30d"));
		expect(page.input.range).toEqual({ preset: "30d" });
	});
});

// #7483 — the footer's four states, and no list count anywhere. The rows are every loaded page;
// more come from the scroll sentinel or the always-visible "Load more", never from a bigger window.
describe("the jobs list's paging footer", () => {
	/** `n` distinct job rows. */
	const rows = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			...JOB,
			id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
		}));

	it("draws every loaded row, and at the end draws no footer and no count", () => {
		page.current = answered(rows(30));
		const { container } = render(<JobsClient />);
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(30);
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(screen.queryByText(/Showing/)).toBeNull();
		expect(screen.queryByText(/\bof\b \d/)).toBeNull();
	});

	it("with more to load: an always-visible Load more that asks for the next page", () => {
		page.current = answered(rows(50), { hasMore: true });
		const { container } = render(<JobsClient />);
		expect(container.querySelector('[data-slot="list-footer"]')?.getAttribute("data-state")).toBe("more");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(page.current.loadMore).toHaveBeenCalledTimes(1);
		// No "Showing the newest 50 of 120" any more, and no count pill: the list carries no sizes.
		expect(screen.queryByText(/Showing the newest/)).toBeNull();
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
	});

	it("while a page loads the button stays in place, disabled and busy", () => {
		page.current = answered(rows(50), { hasMore: true, loadingMore: true });
		const { container } = render(<JobsClient />);
		expect(container.querySelector('[data-slot="list-footer"]')?.getAttribute("data-state")).toBe("loading");
		const button = screen.getByRole("button", { name: "Load more" });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
	});

	it("a failed later page keeps every loaded row and offers Try again — not a region error", () => {
		page.current = answered(rows(50), { hasMore: true, loadMoreFailed: true });
		render(<JobsClient />);
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(50);
		expect(screen.getByText("Couldn't load more")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load jobs")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(page.current.loadMore).toHaveBeenCalledTimes(1);
	});

	it("a change of filters asks with the new query (the hook restarts its walk at page one on a new key)", () => {
		page.current = answered(rows(50), { hasMore: true });
		render(<JobsClient />);
		const before = page.input;
		act(() => useJobsFilters.getState().set("statuses", ["FAILED"]));
		expect(page.input).not.toBe(before);
		expect(page.input.statuses).toEqual(["FAILED"]);
		expect(page.input).not.toHaveProperty("cursor");
	});

	it("the previous filters' rows are dimmed while the new first page loads, and the list says it is busy", () => {
		page.current = answered(rows(5), { isPlaceholderData: true });
		const { container } = render(<JobsClient />);
		expect(container.querySelector(".opacity-60")).not.toBeNull();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
	});
});
