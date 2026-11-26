// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence page's renders (#6126, RUBRIC B1/B3/B4): the first paint is the route's hydrated
// read with NO fetch on mount; a read that has not answered draws the page's skeleton, never an
// empty state; a failed read is the region error with a retry; a REFUSED read (a typed FORBIDDEN)
// is its own render, neither the error nor empty; zero environments is onboarding; and a refresh
// that fails behind rows keeps the rows under a notice. The read is `evidence.page`, faked at the
// `orpc` seam so the real hook, store and URL sync run.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/evidence",
	useSearchParams: () => new URLSearchParams(""),
}));

const { EvidenceClient } = await import("@/components/evidence/evidence-client");
const { useEvidenceFilters } = await import("@/lib/stores/use-evidence-filters");
import type { EvidencePosturePage } from "@/lib/queries/evidence-posture";

/** The infinite key the route prefetches for a link with no filters — what the client reads first. */
const FIRST_KEY = [["evidence", "page"], { input: {}, type: "infinite" }];

/** Page one of the posture walk: one environment ("payments-prod") with no proof yet, or none. */
function result(environments: number): EvidencePosturePage {
	const rows =
		environments === 0
			? []
			: [
					{
						projectId: "p1",
						projectName: "payments",
						projectSlug: "payments",
						environmentId: "e1",
						environmentName: "payments-prod",
						stage: "production" as const,
						provider: "aws",
						region: "eu-west-1",
						verify: null,
						drift: null,
						security: null,
					},
				];
	return {
		rows: rows.length ? [{ id: "p1", key: "p1", label: "payments", rows, provider: "aws", waivers: [] }] : [],
		nextCursor: null,
		facets: { statusOptions: [], stageOptions: [], providerOptions: [] },
		universeEmpty: rows.length === 0,
	};
}

/** The infinite query's cached shape for a walk that has read `pages`. */
function walked(...pages: EvidencePosturePage[]) {
	return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i}`)) };
}

/** Renders the page under the console's query defaults; `seed` plays the route's hydration. */
function renderPage(seed?: EvidencePosturePage) {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
	if (seed) qc.setQueryData(FIRST_KEY, walked(seed));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return { qc, ...render(<EvidenceClient />, { wrapper }) };
}

/** Lets effects and settled promises run. */
async function settle(): Promise<void> {
	await act(async () => {});
}

beforeEach(() => {
	rpc.calls.length = 0;
	for (const k of Object.keys(rpc.handlers)) delete rpc.handlers[k];
	// The waivers panel is a list of its own, read page by page from the browser (#7488); held
	// unanswered here, because these tests are about the roll-up's four renders.
	rpc.handlers["evidence.waivers"] = () => new Promise(() => {});
	sessionStorage.clear();
	useEvidenceFilters.getState().reset();
});

describe("EvidenceClient — four renders, never confused", () => {
	it("first paint is the hydrated read: the rows, and no fetch on mount (B1)", async () => {
		rpc.handlers["evidence.page"] = () => new Promise(() => {});
		renderPage(result(1));
		await settle();
		expect(screen.getByRole("button", { name: "payments-prod" })).toBeInTheDocument();
		// Never scanned is said per row, not as an empty page (F052).
		expect(screen.getAllByText("Not scanned").length).toBeGreaterThan(0);
		expect(screen.queryByText("No environments yet")).toBeNull();
		expect(
			rpc.calls.filter((c) => c.path === "evidence.page"),
			"nothing was fetched for first-paint data",
		).toEqual([]);
	});

	it("an unanswered read draws the page's skeleton — never an empty state (B3)", async () => {
		rpc.handlers["evidence.page"] = () => new Promise(() => {});
		const { container } = renderPage();
		await settle();
		expect(container.querySelector('[data-slot="evidence-skeleton"]')).not.toBeNull();
		expect(screen.queryByText("No environments yet")).toBeNull();
		expect(screen.queryByText("Couldn't load evidence")).toBeNull();
	});

	it("a failed read is the region error with a retry — not empty, not a skeleton (B4)", async () => {
		rpc.handlers["evidence.page"] = () => Promise.reject(new Error("boom"));
		const { container } = renderPage();
		await settle();
		// The page retries a failure once (a refusal never), so the error lands after that retry.
		expect(await screen.findByText("Couldn't load evidence", undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
		expect(container.querySelector('[data-slot="evidence-skeleton"]')).toBeNull();
		expect(screen.queryByText("No environments yet")).toBeNull();
	});

	it("a refused read (typed FORBIDDEN) is its own render — not the error, not empty", async () => {
		rpc.handlers["evidence.page"] = () =>
			Promise.reject(new ORPCError("FORBIDDEN", { defined: true, status: 403 }));
		renderPage();
		await settle();
		// No retry for a refusal: it renders at once (well inside the 1s a retry would wait).
		expect(await screen.findByText("You don't have access to evidence", undefined, { timeout: 500 })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load evidence")).toBeNull();
		expect(screen.queryByText("No environments yet")).toBeNull();
	});

	it("the filters are one ListToolbar row: the search, then the funnel, with no Reset while nothing is set", async () => {
		rpc.handlers["evidence.page"] = () => new Promise(() => {});
		renderPage(result(1));
		await settle();
		const search = screen.getByRole("textbox", { name: "Filter by project or environment…" });
		const row = search.closest('[data-slot="filter-search"]')?.parentElement;
		expect(row).not.toBeNull();
		// The funnel rides in the same row as the page's `extra`, after the search.
		expect(row?.contains(screen.getByRole("button", { name: "Filter & sort" }))).toBe(true);
		expect(screen.queryByRole("button", { name: /^Reset ·/ })).toBeNull();
	});

	it("zero environments is onboarding", async () => {
		renderPage(result(0));
		await settle();
		expect(screen.getByText("No environments yet")).toBeInTheDocument();
	});

	it("a refresh that fails behind rows keeps the rows and says they may be stale", async () => {
		rpc.handlers["evidence.page"] = () => Promise.reject(new Error("boom"));
		const { qc } = renderPage(result(1));
		await settle();
		await act(async () => {
			// The roll-up's read only: the waivers list is held unanswered (see beforeEach).
			await qc.refetchQueries({ queryKey: [["evidence", "page"]] });
		});
		expect(screen.getByRole("button", { name: "payments-prod" })).toBeInTheDocument();
		expect(await screen.findByText(/Couldn't refresh/, undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load evidence")).toBeNull();
	});
});

describe("EvidenceClient — the posture table pages (#7755)", () => {
	/** Page one again, with a cursor to a second page holding the "billing" project. */
	function pageOne(): EvidencePosturePage {
		return { ...result(1), nextCursor: "cursor-1" };
	}

	/** The second page: one more project group, the end of the walk. */
	function pageTwo(): EvidencePosturePage {
		const [group] = result(1).rows;
		if (!group) throw new Error("fixture has no group");
		const row = { ...group.rows[0], projectId: "p2", projectName: "billing", environmentId: "e2", environmentName: "billing-prod" };
		return {
			rows: [{ ...group, id: "p2", key: "p2", label: "billing", rows: [{ ...row, stage: "production" as const }] }],
			nextCursor: null,
			facets: null,
			universeEmpty: null,
		};
	}

	it("Load more reads the next page with the cursor and appends its project group", async () => {
		rpc.handlers["evidence.page"] = async () => pageTwo();
		renderPage(pageOne());
		await settle();
		expect(screen.getByRole("button", { name: "payments-prod" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "billing-prod" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByRole("button", { name: "billing-prod" })).toBeInTheDocument();
		// Page one stays; the walk asked for page two by its cursor, never by a page number.
		expect(screen.getByRole("button", { name: "payments-prod" })).toBeInTheDocument();
		expect(rpc.calls.filter((c) => c.path === "evidence.page").map((c) => c.input)).toEqual([{ cursor: "cursor-1" }]);
		// The end is nothing: no further "Load more".
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});
});
