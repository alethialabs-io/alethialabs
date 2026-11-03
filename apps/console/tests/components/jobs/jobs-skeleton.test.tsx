// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6350 — the jobs list skeleton must be the list's shape (RUBRIC B2). The filter bar WRAPS, and
// where it wraps is decided by its controls' real widths, so the skeleton that drew bars of guessed
// widths wrapped somewhere else: on a project's list it fit one line where the page needs two, and
// the table landed 46px below where the skeleton drew it. The skeleton now renders the list's own
// `JobsFilterBar`. jsdom has no layout, so what is pinned here is that the two bars are the SAME
// controls in the same order, on both routes, and that the table frame has the same columns.

import { render, screen, within } from "@testing-library/react";
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
import { JobsListSkeleton } from "@/components/jobs/jobs-skeleton";

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

beforeEach(() => {
	page.current = {
		data: { rows: [JOB], total: 1, facets: EMPTY_FACETS },
		error: null,
		isError: false,
		isPending: false,
		isLoading: false,
		isPlaceholderData: false,
		refetch: vi.fn(),
	};
});

/** The filter bar a render draws: the row that holds the jobs search. */
function barOf(root: HTMLElement): HTMLElement {
	const bar = within(root).getByLabelText("Search jobs").parentElement?.parentElement;
	if (!bar) throw new Error("no filter bar holds the jobs search");
	return bar;
}

/**
 * The bar's controls, left to right: a text control by its placeholder, a button by its label. Digits
 * are masked: the date control's label is the range, which reads the clock between two renders.
 */
function controls(bar: HTMLElement): string[] {
	return [...bar.children].map((c) => {
		const input = c.querySelector("input");
		if (input) return `input:${input.placeholder}`;
		const button = c.matches("button") ? c : c.querySelector("button");
		if (button) return `button:${(button.textContent ?? "").trim().replace(/\d+/g, "#")}`;
		return `slot:${c.textContent?.trim() ?? ""}`;
	});
}

describe.each([
	{ route: "the org list", projectId: undefined, showProject: true, columns: 6 },
	{ route: "a project's list", projectId: "proj-1", showProject: false, columns: 5 },
])("jobs list skeleton — $route", ({ projectId, showProject, columns }) => {
	it("draws the same filter controls, in the same order, as the list", () => {
		const skeleton = render(<JobsListSkeleton showProject={showProject} />);
		const drawn = controls(barOf(skeleton.container));
		skeleton.unmount();

		const list = render(<JobsClient projectId={projectId} />);
		expect(controls(barOf(list.container))).toEqual(drawn);
	});

	it("draws the Project facet exactly when the list has one", () => {
		const { container } = render(<JobsListSkeleton showProject={showProject} />);
		const placeholders = [...barOf(container).querySelectorAll("input")].map((i) => i.placeholder);
		expect(placeholders.includes("All projects")).toBe(showProject);
	});

	it("draws the table frame with the list's column count", () => {
		const skeleton = render(<JobsListSkeleton showProject={showProject} />);
		const drawn = skeleton.container.querySelectorAll('[data-slot="data-table-skeleton"] thead th').length;
		skeleton.unmount();
		expect(drawn).toBe(columns);

		const list = render(<JobsClient projectId={projectId} />);
		expect(list.container.querySelectorAll("thead th")).toHaveLength(drawn);
	});

	it("is inert and busy: nothing in it can be focused or used while the route loads", () => {
		const { container } = render(<JobsListSkeleton showProject={showProject} />);
		const root = container.querySelector('[data-slot="jobs-list-skeleton"]');
		expect(root).not.toBeNull();
		expect(root?.hasAttribute("inert")).toBe(true);
		expect(root?.getAttribute("aria-busy")).toBe("true");
	});
});

describe("jobs list skeleton — the bar is drawn, not guessed", () => {
	it("renders real filter controls rather than placeholder bars of chosen widths", () => {
		const { container } = render(<JobsListSkeleton showProject={false} />);
		expect(screen.getByLabelText("Search jobs")).toBeInTheDocument();
		expect(barOf(container).querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
	});
});
