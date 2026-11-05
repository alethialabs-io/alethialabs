// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6121 — the jobs list renders FOUR distinct answers (RUBRIC B4): a refusal, a failed read, an
// org with no jobs, and rows. None may stand in for another: a failure rendered as "No jobs yet"
// tells the user something false about their data. And each row is a real link (F025).

import { ORPCError } from "@orpc/client";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted((): { current: Record<string, unknown> } => ({ current: {} }));
vi.mock("@/lib/query/use-jobs-page-query", () => ({ useJobsPageQuery: () => page.current }));
vi.mock("@/lib/query/use-activity-query", () => ({ useMembersQuery: () => ({ data: [], isPending: false }) }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
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

beforeEach(() => {
	page.current = query({});
	useJobsFilters.setState({ filters: DEFAULT_JOBS_FILTERS });
});

describe("the jobs list's four answers", () => {
	it("a refusal renders as a refusal — not an error, not an empty org", () => {
		page.current = query({ isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) });
		render(<JobsClient />);
		expect(screen.getByText("You can't view jobs here")).toBeInTheDocument();
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
		page.current = query({ data: { rows: [], total: 0, facets: EMPTY_FACETS } });
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
		page.current = query({ data: { rows: [JOB], total: 1, facets: EMPTY_FACETS } });
		render(<JobsClient />);
		const link = screen.getByRole("link", { name: /plan/i });
		expect(link).toHaveAttribute("href", `/acme/~/jobs/${JOB.id}`);
	});

	it("a failed REFRESH behind rows keeps the rows (the table's stale notice), not a region error", () => {
		page.current = query({ isError: true, error: new Error("network"), data: { rows: [JOB], total: 1, facets: EMPTY_FACETS } });
		render(<JobsClient />);
		expect(screen.getByRole("link", { name: /plan/i })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load jobs")).toBeNull();
	});
});

// #6459 — the "Show more" window is keyed by the filter set it grew under, not reset by an effect.
describe("the jobs list's Show more window", () => {
	/** `n` distinct job rows. */
	const rows = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			...JOB,
			id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
		}));

	it("grows by 20, and a change of filters starts it again at 20", () => {
		page.current = query({ data: { rows: rows(45), total: 45, facets: EMPTY_FACETS } });
		render(<JobsClient />);
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(20);

		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(40);

		act(() => useJobsFilters.getState().set("statuses", ["FAILED"]));
		expect(screen.getAllByRole("link", { name: /plan/i })).toHaveLength(20);
	});
});
