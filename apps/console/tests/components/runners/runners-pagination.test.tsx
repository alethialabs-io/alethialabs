// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runner grid's page is view state in the URL (`?page=`, lib/query/view-url-params.ts), so a
// link, a refresh and Back reproduce it (R6 C-13: it was a `useState` slice nothing could share).
// It belongs to the filters it was picked under: the page hands `page` to `useFilterUrlSync` as a
// reset param, which drops it on any URL write that changes a filter (that hook's own tests pin the
// drop). The query hooks are stubbed; the pager is a two-button stub.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	page: {} as Record<string, unknown>,
	search: "",
	replace: vi.fn(),
	syncOptions: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: h.replace, push: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/query/use-runners-page-query", () => ({
	useRunnersPageQuery: () => ({ isPlaceholderData: false, refetch: vi.fn(), ...h.page }),
}));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ refetch: vi.fn(), isPending: true, isError: false }),
	useFleetEconomicsQuery: () => ({ data: null }),
	useSetPoolEnabled: () => ({ mutate: vi.fn(), isPending: false }),
	useDeletePool: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ refetch: vi.fn(), isPending: true, isError: false }),
	useUpdateAllOutdated: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-classification-query", () => ({ useAssignmentsForKind: () => ({ data: {} }) }));
vi.mock("@/hooks/use-filter-url-sync", () => ({
	useFilterUrlSync: (_store: unknown, _defaults: unknown, _names: unknown, options: unknown) => {
		h.syncOptions.push(options);
		return true;
	},
}));
vi.mock("@/components/runners/add-runner-button", () => ({ AddRunnerButton: () => null }));
vi.mock("@/components/runners/fleet-pool-wizard", () => ({ FleetPoolWizard: () => null }));
vi.mock("@/components/runners/runners-toolbar", () => ({ RunnersToolbar: () => null }));
vi.mock("@/components/runners/runners-pager", () => ({
	RunnersPager: ({ page, onPageChange }: { page: number; onPageChange: (p: number) => void }) => (
		<div>
			<span>page {page}</span>
			<button type="button" onClick={() => onPageChange(page + 1)}>
				next
			</button>
			<button type="button" onClick={() => onPageChange(page - 1)}>
				previous
			</button>
		</div>
	),
}));
vi.mock("@/components/runners/runner-card", () => ({
	RunnerCard: ({ runner }: { runner: { name: string } }) => <div>card {runner.name}</div>,
	RunnerCardSkeleton: () => <div data-testid="runner-skeleton" />,
}));

import { RunnersClient } from "@/app/(private)/[org]/~/runners/runners-client";
import { DEFAULT_RUNNER_FILTERS } from "@/components/runners/runners-query";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";

const EMPTY_FACETS = { clouds: [], regions: [], versions: [] };
/** Twenty runners: three pages of nine. */
const ROWS = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, name: `runner-${i}` }));

beforeEach(() => {
	h.search = "";
	h.replace.mockClear();
	h.syncOptions = [];
	h.page = {
		isPending: false,
		isError: false,
		data: { rows: ROWS, resultCount: ROWS.length, total: ROWS.length, facets: EMPTY_FACETS },
	};
	useRunnerFilters.setState({ filters: DEFAULT_RUNNER_FILTERS });
});

describe("the runner grid's page", () => {
	it("a bare link is page 1", () => {
		render(<RunnersClient hosted />);
		expect(screen.getByText("page 1")).toBeTruthy();
		expect(screen.getByText("card runner-0")).toBeTruthy();
	});

	it("opens the page the link names", () => {
		h.search = "statuses=ONLINE&page=2";
		render(<RunnersClient hosted />);
		expect(screen.getByText("page 2")).toBeTruthy();
		expect(screen.getByText("card runner-9")).toBeTruthy();
		expect(screen.queryByText("card runner-0")).toBeNull();
	});

	it("a page past the end shows the last page rather than an empty grid", () => {
		h.search = "page=9";
		render(<RunnersClient hosted />);
		expect(screen.getByText("page 3")).toBeTruthy();
		expect(screen.getByText("card runner-18")).toBeTruthy();
	});

	it("the pager writes the page into the URL, keeping the filters, and page 1 is the bare param", () => {
		h.search = "statuses=ONLINE";
		const { unmount } = render(<RunnersClient hosted />);
		fireEvent.click(screen.getByRole("button", { name: "next" }));
		expect(h.replace).toHaveBeenLastCalledWith("/acme/~/runners?statuses=ONLINE&page=2", { scroll: false });
		unmount();

		h.search = "statuses=ONLINE&page=2";
		render(<RunnersClient hosted />);
		fireEvent.click(screen.getByRole("button", { name: "previous" }));
		expect(h.replace).toHaveBeenLastCalledWith("/acme/~/runners?statuses=ONLINE", { scroll: false });
	});

	it("hands the page param to the URL sync as filter-dependent, so a filter change starts again at page 1", () => {
		render(<RunnersClient hosted />);
		const resetParams = h.syncOptions
			.map((o) => (typeof o === "object" && o !== null && "resetParams" in o ? o.resetParams : null))
			.find((p) => p !== null);
		expect(resetParams).toEqual(["page"]);
	});
});
