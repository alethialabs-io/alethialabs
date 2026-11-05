// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the runner grid's page belongs to the query it was picked under: a different result set
// starts at page 1. The page is now keyed by the query instead of reset by an effect. This pins the
// outcome, not the timing: Testing Library flushes effects inside act, so the old effect reached the
// same end state. The query hooks are stubbed; the pager is a two-button stub.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ page: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/query/use-runners-page-query", () => ({
	useRunnersPageQuery: () => ({ isPlaceholderData: false, refetch: vi.fn(), ...h.page }),
}));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ refetch: vi.fn(), isPending: true, isError: false }),
	useFleetEconomicsQuery: () => ({ data: null }),
	useSetPoolEnabled: () => ({ mutate: vi.fn(), isPending: false }),
	useDeletePool: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ refetch: vi.fn(), isPending: true, isError: false }),
	useUpdateAllOutdated: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-classification-query", () => ({ useAssignmentsForKind: () => ({ data: {} }) }));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => true }));
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
	h.page = {
		isPending: false,
		isError: false,
		data: { rows: ROWS, resultCount: ROWS.length, total: ROWS.length, facets: EMPTY_FACETS },
	};
	useRunnerFilters.setState({ filters: DEFAULT_RUNNER_FILTERS });
});

describe("the runner grid's page", () => {
	it("moves with the pager, and a change of filters starts it again at page 1", () => {
		render(<RunnersClient hosted />);
		expect(screen.getByText("page 1")).toBeTruthy();
		expect(screen.getByText("card runner-0")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "next" }));
		expect(screen.getByText("page 2")).toBeTruthy();
		expect(screen.getByText("card runner-9")).toBeTruthy();
		expect(screen.queryByText("card runner-0")).toBeNull();

		act(() => useRunnerFilters.getState().set("statuses", ["online"]));
		expect(screen.getByText("page 1")).toBeTruthy();
		expect(screen.getByText("card runner-0")).toBeTruthy();
	});
});
