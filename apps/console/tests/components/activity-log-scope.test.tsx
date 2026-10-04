// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the scope-aware Activity feed: when pinned to a project, the feed forces the
// project's id onto the query, hides the redundant Project facet + Export, and shows the scope
// caption. At the org scope the Project facet is back and no scope is forced.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A flat list of projects under the org, as the projects query returns them.
const PROJECTS = [
	{ id: "s1", project_name: "api", slug: "api" },
	{ id: "s2", project_name: "web", slug: "web" },
];

vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
// The activity feed now fetches through TanStack (filters in the key), whose hooks read
// the org from the route params.
// ActivityLog now runs the documented filter pipeline, and `useFilterUrlSync` reads the router,
// the pathname and the search params to mirror non-default filters into the URL. A mock that
// returns only `useParams` makes the component throw before it renders anything — so these are
// the pipeline's dependencies, not decoration.
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	useSearchParams: () => new URLSearchParams(),
}));

/** Renders under a fresh QueryClient (retries off so a mock rejection fails fast). */
function render(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return rtlRender(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({ data: PROJECTS }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({
	useEntitlement: () => false,
}));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/app/server/actions/members", () => ({ getMembers: vi.fn() }));
vi.mock("@/app/server/actions/activity", () => ({
	getActivityLog: vi.fn(),
	getActivityExportCsv: vi.fn(),
}));

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { getMembers } from "@/app/server/actions/members";
import { getActivityLog } from "@/app/server/actions/activity";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getMembers).mockResolvedValue([]);
	vi.mocked(getActivityLog).mockResolvedValue({ rows: [], nextCursor: null, facets: null });
});

describe("ActivityLog — project scope", () => {
	it("forces the project's id, hides the Project facet + Export, and captions the scope", async () => {
		render(<ActivityLog projectId="s1" />);

		// Forced scope: the first query carries the project id as SCOPE, not as the Project
		// facet's filter — the server's facet counts must see the one and never the other.
		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.projectId).toBe("s1");
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.resourceIds).toBeUndefined();

		// Redundant controls are gone; the caption names the project.
		expect(screen.queryByText("Project")).toBeNull();
		expect(screen.queryByRole("button", { name: /export csv/i })).toBeNull();
		expect(await screen.findByText(/activity in/i)).toBeInTheDocument();
		expect(screen.getByText("api")).toBeInTheDocument();
	});
});

describe("ActivityLog — org scope", () => {
	it("keeps the Project facet and forces no resource scope", async () => {
		render(<ActivityLog />);

		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.resourceIds).toBeUndefined();
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.projectId).toBeUndefined();

		expect(screen.getByText("Project")).toBeInTheDocument();
		expect(screen.queryByText(/activity in/i)).toBeNull();
	});
});

describe("ActivityLog — busy until it has answered (#5471)", () => {
	it("declares aria-busy while the first page is in flight, and clears it once the page lands", async () => {
		// Held open, so the first answer has demonstrably not arrived when the busy state is read.
		let land: (page: Awaited<ReturnType<typeof getActivityLog>>) => void = () => {};
		vi.mocked(getActivityLog).mockImplementation(
			() =>
				new Promise((resolve) => {
					land = resolve;
				}),
		);
		const { container } = render(<ActivityLog projectId="s1" />);

		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		// Before the first answer the feed shows a skeleton with no count, no table and no empty
		// state. Without `aria-busy` nothing marks that as "not answered yet".
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

		land({ rows: [], nextCursor: null, facets: null });
		await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
		expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
	});
});
