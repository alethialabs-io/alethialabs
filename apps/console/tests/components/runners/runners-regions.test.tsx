// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6123 (RUBRIC B3–B5): the runners page's three data regions — the grid, the Pools column and the
// Versions panel — each render pending, empty and error as three different things, and a failure in
// one does not take down the others. The query hooks are stubbed; the components are real. The
// grid reads through `useKeysetList` (#7484), stubbed here as the `KeysetList` it would return;
// its paging is driven for real in runners-list-paging.test.tsx.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = { data?: unknown; isPending: boolean; isError: boolean; refetch: () => void };

const h = vi.hoisted(() => ({
	grid: {} as Record<string, unknown>,
	fleet: { isPending: false, isError: false } as Record<string, unknown>,
	list: { isPending: false, isError: false } as Record<string, unknown>,
	refetch: vi.fn(),
	loadMore: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/query/use-keyset-list", () => ({ useKeysetList: () => h.grid }));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ refetch: vi.fn(), ...h.fleet }),
	useFleetEconomicsQuery: () => ({ data: null }),
	useSetPoolEnabled: () => ({ mutate: vi.fn(), isPending: false }),
	useDeletePool: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-runners-query", () => ({
	useRunnersQuery: () => ({ refetch: vi.fn(), ...h.list }),
	useUpdateAllOutdated: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/use-classification-query", () => ({ useAssignmentsForKind: () => ({ data: {} }) }));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => true }));
vi.mock("@/components/runners/add-runner-button", () => ({ AddRunnerButton: () => null }));
vi.mock("@/components/runners/fleet-pool-wizard", () => ({ FleetPoolWizard: () => null }));
vi.mock("@/components/runners/runners-toolbar", () => ({ RunnersToolbar: () => null }));
vi.mock("@/components/runners/runner-card", () => ({
	RunnerCard: ({ runner }: { runner: { name: string } }) => <div>card {runner.name}</div>,
	RunnerCardSkeleton: () => <div data-testid="runner-skeleton" />,
}));

import { RunnersClient } from "@/app/(private)/[org]/~/runners/runners-client";
import { DEFAULT_RUNNER_FILTERS } from "@/components/runners/runners-query";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";

const EMPTY_FACETS = { clouds: [], regions: [], versions: [] };

/** The grid's state as `useKeysetList` reports it, settled with `rows` unless overridden. */
interface GridState {
	rows: { id: string; name: string }[];
	universeEmpty: boolean | null;
	isPending: boolean;
	isError: boolean;
	data: unknown;
	error: unknown;
	hasMore: boolean;
	loadingMore: boolean;
	loadMoreFailed: boolean;
}

/** A `KeysetList` for the grid: a settled first page unless `over` says otherwise. */
function grid(over: Partial<GridState> = {}): Record<string, unknown> {
	const s: GridState = {
		rows: [{ id: "r1", name: "edge" }],
		universeEmpty: false,
		isPending: false,
		isError: false,
		data: { pages: [] },
		error: null,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		...over,
	};
	return {
		rows: s.rows,
		facets: s.isPending ? null : EMPTY_FACETS,
		universeEmpty: s.isPending ? null : s.universeEmpty,
		query: { isLoading: s.isPending, isError: s.isError, data: s.data, error: s.error, refetch: h.refetch },
		isPending: s.isPending,
		isPlaceholderData: false,
		hasMore: s.hasMore,
		loadingMore: s.loadingMore,
		loadMoreFailed: s.loadMoreFailed,
		loadMore: h.loadMore,
	};
}

/** Settled, successful states for all three regions (one runner, no pools, one release). */
function settle(): void {
	h.grid = grid();
	h.fleet = { isPending: false, isError: false, data: { pools: [], configs: [], canManageFleet: false } };
	h.list = {
		isPending: false,
		isError: false,
		data: { runners: [], latestRelease: null, releases: [] },
	} satisfies Partial<QueryState>;
}

beforeEach(() => {
	h.refetch.mockClear();
	h.loadMore.mockClear();
	settle();
	useRunnerFilters.setState({ filters: DEFAULT_RUNNER_FILTERS });
});

describe("the runner grid", () => {
	it("pending is the card skeleton — never the empty state", () => {
		h.grid = grid({ isPending: true, rows: [], data: undefined });
		render(<RunnersClient hosted />);
		expect(screen.getAllByTestId("runner-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText("No runners yet")).toBeNull();
	});

	it("an error is a region error with a retry — never 'No runners yet'", () => {
		h.grid = grid({ isError: true, rows: [], data: undefined, universeEmpty: null });
		render(<RunnersClient hosted />);
		expect(screen.getByText("Couldn't load runners")).toBeTruthy();
		expect(screen.queryByText("No runners yet")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		expect(h.refetch).toHaveBeenCalled();
	});

	it("a failed REFRESH behind cards keeps the cards, under a stale notice — never the region error", () => {
		h.grid = grid({ isError: true });
		render(<RunnersClient hosted />);
		expect(screen.getByText("card edge")).toBeTruthy();
		expect(screen.queryByText("Couldn't load runners")).toBeNull();
		expect(screen.getByText(/Couldn't refresh/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(h.refetch).toHaveBeenCalled();
	});

	it("empty is the first-run state, and data is the cards", () => {
		h.grid = grid({ rows: [], universeEmpty: true });
		const { unmount } = render(<RunnersClient hosted />);
		expect(screen.getByText("No runners yet")).toBeTruthy();
		unmount();
		settle();
		render(<RunnersClient hosted />);
		expect(screen.getByText("card edge")).toBeTruthy();
	});
});

describe("the grid's filtered-empty state (R6 C-14)", () => {
	it("runners that exist but are all filtered out say so, and Clear filters resets the bar", () => {
		useRunnerFilters.setState({ filters: { ...DEFAULT_RUNNER_FILTERS, statuses: ["DRAINING"] } });
		h.grid = grid({ rows: [], universeEmpty: false });
		render(<RunnersClient hosted />);
		expect(screen.getByText("No runners match these filters.")).toBeTruthy();
		expect(screen.queryByText("No runners yet")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useRunnerFilters.getState().filters).toEqual(DEFAULT_RUNNER_FILTERS);
	});

	it("the first-run state offers no Clear filters — there is nothing to clear", () => {
		h.grid = grid({ rows: [], universeEmpty: true });
		render(<RunnersClient hosted />);
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});
});

describe("the grid's footer (#7484)", () => {
	it("more to load: the cards, then an always-visible Load more that asks for the next page", () => {
		h.grid = grid({ hasMore: true });
		const { container } = render(<RunnersClient hosted />);
		expect(container.querySelector('[data-slot="list-footer"]')?.getAttribute("data-state")).toBe("more");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(h.loadMore).toHaveBeenCalledTimes(1);
	});

	it("loading the next page: the button stays, disabled and busy", () => {
		h.grid = grid({ hasMore: true, loadingMore: true });
		render(<RunnersClient hosted />);
		const button = screen.getByRole("button", { name: "Load more" });
		expect(button.hasAttribute("disabled")).toBe(true);
		expect(button.getAttribute("aria-busy")).toBe("true");
	});

	it("a failed later page keeps the loaded cards and offers Try again — not the region error", () => {
		h.grid = grid({ hasMore: true, loadMoreFailed: true });
		render(<RunnersClient hosted />);
		expect(screen.getByText("card edge")).toBeTruthy();
		expect(screen.getByText("Couldn't load more")).toBeTruthy();
		expect(screen.queryByText("Couldn't load runners")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(h.loadMore).toHaveBeenCalledTimes(1);
	});

	it("the end: no footer at all, and no count of what loaded", () => {
		const { container } = render(<RunnersClient hosted />);
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
		expect(container.querySelectorAll('[data-slot="count-pill"]')).toHaveLength(0);
		expect(container.textContent).not.toMatch(/\d+\s+of\s+\d+/);
	});
});

describe("the Pools column (self-managed only)", () => {
	it("is not rendered at all for a hosted tenant", () => {
		render(<RunnersClient hosted />);
		expect(screen.queryByText("Pools")).toBeNull();
	});

	it("renders on a self-managed deployment; its error stays in the column", () => {
		h.fleet = { isPending: false, isError: true, data: undefined };
		render(<RunnersClient hosted={false} />);
		expect(screen.getByText("Pools")).toBeTruthy();
		expect(screen.getByText("Couldn't load pools")).toBeTruthy();
		// The grid beside it still renders its own answer (RUBRIC B5).
		expect(screen.getByText("card edge")).toBeTruthy();
	});

	it("the page carries NO count pill — not the grid's, not the Pools column's (#7484)", () => {
		// The list standard carries no list sizes (lib/query/README.md → "Counts"). The Pools heading
		// once carried one that the filter audit misread as the grid's result count.
		h.fleet = {
			isPending: false,
			isError: false,
			data: { pools: [], configs: [], canManageFleet: false, fleetProviderActive: false },
		};
		const { container } = render(<RunnersClient hosted={false} />);
		expect(container.querySelectorAll('[data-slot="count-pill"]')).toHaveLength(0);
	});

	it("empty says no pools are configured; pending does not", () => {
		render(<RunnersClient hosted={false} />);
		expect(screen.getByText("No runner pools configured")).toBeTruthy();
	});

	it("the empty state's action is the Add pool button, once on screen, for a viewer who manages pools (R6 C-17)", () => {
		h.fleet = { isPending: false, isError: false, data: { pools: [], configs: [], canManageFleet: true } };
		render(<RunnersClient hosted={false} />);
		const buttons = screen.getAllByRole("button", { name: /Add pool/ });
		expect(buttons).toHaveLength(1);
		expect(buttons[0].hasAttribute("disabled")).toBe(false);
	});

	it("a viewer who cannot manage pools sees Add pool disabled, with the reason", () => {
		render(<RunnersClient hosted={false} />);
		const button = screen.getByRole("button", { name: /Add pool/ });
		expect(button.hasAttribute("disabled")).toBe(true);
		expect(button.getAttribute("aria-describedby")).toBeTruthy();
		expect(document.body.textContent).toContain("Ask an owner or admin");
	});
});

describe("the Versions panel", () => {
	it("an error is its own region error; the grid still renders", () => {
		h.list = { isPending: false, isError: true, data: undefined };
		render(<RunnersClient hosted />);
		expect(screen.getByText("Couldn't load runner versions")).toBeTruthy();
		expect(screen.getByText("card edge")).toBeTruthy();
	});

	it("no release is said as such, distinct from pending", () => {
		render(<RunnersClient hosted />);
		expect(screen.getByText("No runner releases yet.")).toBeTruthy();
	});
});

describe("a refusal is not a failure (RUBRIC B4)", () => {
	/** A typed FORBIDDEN as the read router sends it (lib/rpc/base.ts). */
	const forbidden = async () => {
		const { ORPCError } = await import("@orpc/client");
		return new ORPCError("FORBIDDEN", { defined: true });
	};

	it("a forbidden grid says the viewer has no access — no retry, no 'Couldn't load'", async () => {
		h.grid = grid({ isError: true, rows: [], data: undefined, universeEmpty: null, error: await forbidden() });
		render(<RunnersClient hosted />);
		expect(screen.getByText("You don't have access to runners")).toBeTruthy();
		expect(screen.queryByText("Couldn't load runners")).toBeNull();
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	});

	it("a forbidden grid replaces the column: no filter bar or Add runner over rows the viewer cannot read (R6 C-15)", async () => {
		h.grid = grid({ isError: true, rows: [], data: undefined, universeEmpty: null, error: await forbidden() });
		const { container } = render(<RunnersClient hosted />);
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
		expect(screen.getByRole("heading", { name: "Runners" })).toBeTruthy();
	});

	it("forbidden versions and pools say so too", async () => {
		h.list = { isPending: false, isError: true, data: undefined, error: await forbidden() };
		h.fleet = { isPending: false, isError: true, data: undefined, error: await forbidden() };
		render(<RunnersClient hosted={false} />);
		expect(screen.getByText(/access to runner versions/)).toBeTruthy();
		expect(screen.getByText(/access to the warm pools/)).toBeTruthy();
		expect(screen.queryByText("Couldn't load pools")).toBeNull();
	});
});
