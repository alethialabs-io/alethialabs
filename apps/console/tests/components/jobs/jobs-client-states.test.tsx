// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6121 — the jobs list renders FOUR distinct answers (RUBRIC B4): a refusal, a failed read, an
// org with no jobs, and rows. None may stand in for another: a failure rendered as "No jobs yet"
// tells the user something false about their data. And each row is a real link (F025).

import { ORPCError } from "@orpc/client";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The read's answer, and the input the list last asked it with.
const page = vi.hoisted((): { current: Record<string, unknown>; input: Record<string, unknown> } => ({
	current: {},
	input: {},
}));
const route = vi.hoisted((): { params: Record<string, string> } => ({ params: { org: "acme" } }));
vi.mock("@/lib/query/use-jobs-page-query", () => ({
	useJobsPageQuery: (input: Record<string, unknown>) => {
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
import { DEFAULT_JOBS_FILTERS, JOBS_PAGE_MAX, JOBS_PAGE_SIZE } from "@/components/jobs/jobs-query";
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

/** A query result in a given state. */
function query(state: Record<string, unknown>) {
	return {
		data: undefined,
		error: null,
		isError: false,
		isPending: false,
		isLoading: false,
		isPlaceholderData: false,
		refetch: vi.fn(),
		...state,
	};
}

/** The read's answer for `rows`, of `matched` matching jobs in a scope holding `total`. */
function answer(rows: unknown[], counts: { matched?: number; total?: number } = {}) {
	return { rows, matched: counts.matched ?? rows.length, total: counts.total ?? rows.length, facets: EMPTY_FACETS };
}

beforeEach(() => {
	page.current = query({});
	page.input = {};
	route.params = { org: "acme" };
	useJobsFilters.setState({ filters: DEFAULT_JOBS_FILTERS });
});

describe("the jobs list's four answers", () => {
	it("a refusal renders as a refusal — not an error, not an empty org", () => {
		page.current = query({ isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) });
		const { container } = render(<JobsClient />);
		// The shared refusal render and wording (components/errors/region-refusal.tsx), no retry.
		expect(screen.getByText("You don't have access to jobs")).toBeInTheDocument();
		expect(container.querySelector('[data-state="refused"][data-refusal="forbidden"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("No jobs yet")).toBeNull();
	});

	it("a failed read renders as a region error with a retry — never as an empty org", () => {
		page.current = query({ isError: true, error: new Error("network") });
		render(<JobsClient />);
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load jobs");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText("No jobs yet")).toBeNull();
	});

	it("an org with no jobs renders its onboarding empty state", () => {
		page.current = query({ data: answer([]) });
		render(<JobsClient />);
		expect(screen.getByText("No jobs yet")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("a pending read shows neither the empty state nor 'No results.'", () => {
		page.current = query({ isPending: true, isLoading: true });
		render(<JobsClient />);
		expect(screen.queryByText("No jobs yet")).toBeNull();
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("rows render, each with a real link to its job", () => {
		page.current = query({ data: answer([JOB]) });
		render(<JobsClient />);
		const link = screen.getByRole("link", { name: /plan/i });
		expect(link).toHaveAttribute("href", `/acme/~/jobs/${JOB.id}`);
	});

	it("a failed REFRESH behind rows keeps the rows (the table's stale notice), not a region error", () => {
		page.current = query({ isError: true, error: new Error("network"), data: answer([JOB]) });
		render(<JobsClient />);
		expect(screen.getByRole("link", { name: /plan/i })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load jobs")).toBeNull();
	});
});

describe("an empty list says which kind of empty it is", () => {
	it("an org with no jobs offers to create a project", () => {
		page.current = query({ data: answer([]) });
		render(<JobsClient />);
		expect(screen.getByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Create a project" })).toHaveAttribute("href", "/acme/~/new");
	});

	// D-04: a new project in an org that HAS jobs used to read "No jobs match these filters" with a
	// Clear button that did nothing, because the project was a filter and the total was the org's.
	it("a project with no jobs yet gets its own first-run state, pointing at its Architecture", () => {
		route.params = { org: "acme", project: "payments" };
		page.current = query({ data: answer([]) });
		render(<JobsClient projectId="proj-1" />);
		expect(screen.getByRole("heading", { name: "No jobs for this project yet" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open Architecture" })).toHaveAttribute(
			"href",
			"/acme/payments/architecture",
		);
		expect(screen.queryByText("No jobs match these filters")).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});

	it("jobs that exist but are all filtered out say so, and Clear filters resets every filter — the range too", () => {
		page.current = query({ data: answer([], { matched: 0, total: 12 }) });
		render(<JobsClient />);
		// After the mount: the link replaces the store when the page mounts (a bare link is the
		// pristine list), so a selection made before it would not survive to be cleared.
		act(() => useJobsFilters.getState().patch({ statuses: ["FAILED"], range: "7d" }));
		expect(useJobsFilters.getState().filters.range).toBe("7d");
		expect(screen.getByRole("heading", { name: "No jobs match these filters" })).toBeInTheDocument();
		expect(screen.queryByText("No jobs yet")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useJobsFilters.getState().filters).toEqual(DEFAULT_JOBS_FILTERS);
	});
});

describe("what the list asks the read for", () => {
	it("a project's list sends the project as its scope, never as a Project filter", () => {
		route.params = { org: "acme", project: "payments" };
		page.current = query({ data: answer([JOB]) });
		render(<JobsClient projectId="proj-1" />);
		act(() => useJobsFilters.getState().set("projects", ["some-other-project"]));
		expect(page.input.projectId).toBe("proj-1");
		expect(page.input.projects).toBeUndefined();
	});

	it("the org list sends no scope", () => {
		page.current = query({ data: answer([JOB]) });
		render(<JobsClient />);
		expect(page.input).toEqual({ range: { preset: "12mo" } });
	});

	it("the date range is a filter like the rest: a picked preset reaches the read unresolved", () => {
		page.current = query({ data: answer([JOB]) });
		render(<JobsClient />);
		act(() => useJobsFilters.getState().set("range", "30d"));
		expect(page.input.range).toEqual({ preset: "30d" });
	});
});

// The rows are a bounded window of what the filters match (D-12): the list says how many it shows
// of how many, and asks for a larger window on demand. The window belongs to the filter set it
// grew under (#6459: keyed, not reset by an effect).
describe("the jobs list's row window", () => {
	/** `n` distinct job rows. */
	const rows = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			...JOB,
			id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
		}));

	it("draws every row it was given and no footer when that is all of them", () => {
		page.current = query({ data: answer(rows(30)) });
		render(<JobsClient />);
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(30);
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
		expect(screen.queryByText(/Showing the newest/)).toBeNull();
	});

	it("says how many of the matching jobs it shows, and Show more asks for the next window", () => {
		page.current = query({ data: answer(rows(JOBS_PAGE_SIZE), { matched: 120, total: 300 }) });
		render(<JobsClient />);
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(JOBS_PAGE_SIZE);
		expect(screen.getByText(`Showing the newest ${JOBS_PAGE_SIZE} of 120`)).toBeInTheDocument();
		// The first window is the absent field: the key the server prefetched.
		expect(page.input.limit).toBeUndefined();

		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(page.input.limit).toBe(JOBS_PAGE_SIZE * 2);
	});

	it("a change of filters starts again at the first window", () => {
		page.current = query({ data: answer(rows(JOBS_PAGE_SIZE), { matched: 120, total: 300 }) });
		render(<JobsClient />);
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(page.input.limit).toBe(JOBS_PAGE_SIZE * 2);

		act(() => useJobsFilters.getState().set("statuses", ["FAILED"]));
		expect(page.input.limit).toBeUndefined();
		expect(page.input.statuses).toEqual(["FAILED"]);
	});

	it("cannot be pressed again while the larger window is still loading", () => {
		page.current = query({
			data: answer(rows(JOBS_PAGE_SIZE), { matched: 120, total: 300 }),
			isPlaceholderData: true,
		});
		render(<JobsClient />);
		expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
	});

	it("at the cap it stops offering more and says to narrow the filters", () => {
		page.current = query({ data: answer(rows(JOBS_PAGE_MAX), { matched: 900, total: 900 }) });
		render(<JobsClient />);
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
		expect(
			screen.getByText(`Showing the newest ${JOBS_PAGE_MAX} of 900. Narrow the filters to reach older jobs.`),
		).toBeInTheDocument();
	});
});
