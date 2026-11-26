// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6350 — the jobs list skeleton must be the list's shape (RUBRIC B2). Since #7738 the list's filter
// row is the one-row `ListToolbar`, and the skeleton is its `ListToolbarSkeleton`, built from the
// same layout classes. jsdom has no layout, so what is pinned here is that the skeleton draws ONE
// placeholder per control the list renders — the search, each facet (the Project facet exactly when
// the list has one), the range — no description line, and the same table columns, on both routes.

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted((): { current: Record<string, unknown> } => ({ current: {} }));
vi.mock("@/lib/query/use-keyset-list", () => ({ useKeysetList: () => page.current }));
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
		rows: [JOB],
		facets: EMPTY_FACETS,
		universeEmpty: false,
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: vi.fn(),
		query: { isLoading: false, isError: false, data: { pages: [{ rows: [JOB] }] }, error: null, refetch: vi.fn() },
	};
});

/** The list's toolbar row: the row that holds the jobs search. */
function toolbarOf(root: HTMLElement): HTMLElement {
	const row = root.querySelector('[data-slot="filter-search"]')?.parentElement;
	if (!row) throw new Error("no toolbar holds the jobs search");
	return row;
}

/** The skeleton's toolbar row. */
function skeletonToolbarOf(root: HTMLElement): HTMLElement {
	const row = root.querySelector<HTMLElement>('[data-slot="list-toolbar-skeleton"]');
	if (!row) throw new Error("the jobs skeleton drew no toolbar");
	return row;
}

describe.each([
	{ route: "the org list", projectId: undefined, showProject: true, columns: 6, facets: 5 },
	{ route: "a project's list", projectId: "proj-1", showProject: false, columns: 5, facets: 4 },
])("jobs list skeleton — $route", ({ projectId, showProject, columns, facets }) => {
	it("draws one placeholder per toolbar control the list renders, and no description line", () => {
		const skeleton = render(<JobsListSkeleton showProject={showProject} />);
		const drawn = skeletonToolbarOf(skeleton.container);
		expect(drawn.querySelectorAll('[data-part="search"]')).toHaveLength(1);
		expect(drawn.querySelectorAll('[data-part="facet"]')).toHaveLength(facets);
		expect(drawn.querySelectorAll('[data-part="date-range"]')).toHaveLength(1);
		expect(drawn.querySelectorAll('[data-part="action"]')).toHaveLength(0);
		expect(skeleton.container.querySelector('[data-slot="page-toolbar-skeleton"]')).toBeNull();
		skeleton.unmount();

		const list = render(<JobsClient projectId={projectId} />);
		const row = toolbarOf(list.container);
		expect(row.querySelectorAll('[data-slot="filter-search"]')).toHaveLength(1);
		expect(row.querySelectorAll('[data-slot="facet-filter"]')).toHaveLength(facets);
		expect(list.container.querySelector('[data-slot="page-toolbar"]')).toBeNull();
	});

	it("names the Project facet exactly when the list has one", () => {
		const { container } = render(<JobsClient projectId={projectId} />);
		const labels = [...toolbarOf(container).querySelectorAll('[data-slot="facet-filter"] button')].map((b) =>
			(b.textContent ?? "").trim(),
		);
		expect(labels).toEqual(showProject ? ["Author", "Environment", "Project", "Status", "Type"] : ["Author", "Environment", "Status", "Type"]);
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

	it("is never a spinner", () => {
		const { container } = render(<JobsListSkeleton showProject={showProject} />);
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});
