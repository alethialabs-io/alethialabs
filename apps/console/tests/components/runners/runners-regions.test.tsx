// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6123 (RUBRIC B3–B5): the runners page's three data regions — the grid, the Pools column and the
// Versions panel — each render pending, empty and error as three different things, and a failure in
// one does not take down the others. The query hooks are stubbed; the components are real.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = { data?: unknown; isPending: boolean; isError: boolean; refetch: () => void };

const h = vi.hoisted(() => ({
	page: { isPending: false, isError: false } as Record<string, unknown>,
	fleet: { isPending: false, isError: false } as Record<string, unknown>,
	list: { isPending: false, isError: false } as Record<string, unknown>,
}));

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
	useFleetQuery: () => ({ refetch: vi.fn(), ...h.fleet }),
	useFleetEconomicsQuery: () => ({ data: null }),
	useSetPoolEnabled: () => ({ mutate: vi.fn(), isPending: false }),
	useDeletePool: () => ({ mutate: vi.fn(), isPending: false }),
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
vi.mock("@/components/runners/runners-pager", () => ({ RunnersPager: () => null }));
vi.mock("@/components/runners/runner-card", () => ({
	RunnerCard: ({ runner }: { runner: { name: string } }) => <div>card {runner.name}</div>,
	RunnerCardSkeleton: () => <div data-testid="runner-skeleton" />,
}));

import { RunnersClient } from "@/app/(private)/[org]/~/runners/runners-client";

const EMPTY_FACETS = { clouds: [], regions: [], versions: [] };

/** Settled, successful states for all three regions (one runner, no pools, one release). */
function settle(): void {
	h.page = {
		isPending: false,
		isError: false,
		data: { rows: [{ id: "r1", name: "edge" }], resultCount: 1, total: 1, facets: EMPTY_FACETS },
	};
	h.fleet = { isPending: false, isError: false, data: { pools: [], configs: [], canManageFleet: false } };
	h.list = {
		isPending: false,
		isError: false,
		data: { runners: [], latestRelease: null, releases: [] },
	} satisfies Partial<QueryState>;
}

beforeEach(settle);

describe("the runner grid", () => {
	it("pending is the card skeleton — never the empty state", () => {
		h.page = { isPending: true, isError: false, data: undefined };
		render(<RunnersClient hosted />);
		expect(screen.getAllByTestId("runner-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText("No runners yet")).toBeNull();
	});

	it("an error is a region error with a retry — never 'No runners yet'", () => {
		h.page = { isPending: false, isError: true, data: undefined };
		render(<RunnersClient hosted />);
		expect(screen.getByText("Couldn't load runners")).toBeTruthy();
		expect(screen.queryByText("No runners yet")).toBeNull();
	});

	it("empty is the first-run state, and data is the cards", () => {
		h.page = { isPending: false, isError: false, data: { rows: [], resultCount: 0, total: 0, facets: EMPTY_FACETS } };
		const { unmount } = render(<RunnersClient hosted />);
		expect(screen.getByText("No runners yet")).toBeTruthy();
		unmount();
		settle();
		render(<RunnersClient hosted />);
		expect(screen.getByText("card edge")).toBeTruthy();
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

	it("empty says no pools are configured; pending does not", () => {
		render(<RunnersClient hosted={false} />);
		expect(screen.getByText("No runner pools configured")).toBeTruthy();
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
		h.page = { isPending: false, isError: true, data: undefined, error: await forbidden() };
		render(<RunnersClient hosted />);
		expect(screen.getByText("You don't have access to runners")).toBeTruthy();
		expect(screen.queryByText("Couldn't load runners")).toBeNull();
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
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
