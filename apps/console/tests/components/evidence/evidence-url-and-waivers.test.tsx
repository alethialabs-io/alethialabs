// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (R6 C-32, C-36). The evidence drawer and its tab are URL state: a link carrying
// `?selected=<env>&tab=<tab>` opens on that drawer and tab, and opening a row writes both in place.
// The recorded-waivers panel is its own keyset-paged read (#7488): every waiver is reachable — the
// 101st included, which the old 100-row cap made unreachable — with no count pill and no page numbers.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
const url = vi.hoisted(() => ({ search: "" }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/evidence",
	useSearchParams: () => new URLSearchParams(url.search),
}));

const { EvidenceClient } = await import("@/components/evidence/evidence-client");
const { EvidenceWaivers } = await import("@/components/evidence/evidence-waivers");
const { useEvidenceFilters } = await import("@/lib/stores/use-evidence-filters");
import type { EvidenceWaiverRow } from "@/lib/queries/evidence";
import { decodeKeysetCursor, keysetPageInMemory, type KeysetListPage } from "@/lib/queries/keyset";
import type { EvidencePosturePage } from "@/lib/queries/evidence-posture";

/** The key the route prefetches for a link with no filters. */
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

/** Renders the page with its read hydrated. */
function renderPage(seed: EvidencePosturePage) {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
	qc.setQueryData(FIRST_KEY, walked(seed));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<EvidenceClient />, { wrapper });
}

/** Long enough for the list hook's one retry of a real failure (TanStack's first back-off is 1s). */
const RETRIED = 4000;

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Waiver `i` of a log of `total`: waiver 0 is the newest. Recorded in threes on the SAME instant, so
 * every page boundary the walk crosses can fall inside a tie that only the id breaks.
 */
function waiver(i: number, total: number): EvidenceWaiverRow {
	const id = uuid(total - i);
	return {
		id,
		jobId: id,
		projectName: `project-${i}`,
		environmentName: null,
		controls: [],
		reason: `reason ${i}`,
		by: "ada@example.com",
		expiry: null,
		active: i % 2 === 0,
		createdAt: new Date(Date.UTC(2026, 5, 1) + Math.floor((total - i) / 3) * 1000).toISOString(),
	};
}

/** The server half of `evidence.waivers` over an in-memory log, through the real keyset contract. */
function serveWaivers(log: EvidenceWaiverRow[], limit = 50) {
	return async (input: unknown): Promise<KeysetListPage<EvidenceWaiverRow, null>> => {
		const raw = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
		const cursor = typeof raw === "string" ? (decodeKeysetCursor(raw) ?? undefined) : undefined;
		if (raw !== undefined && cursor === undefined) throw new Error("400: malformed cursor");
		const page = keysetPageInMemory(log, { cursor, limit }, (w) => ({ at: w.createdAt, id: w.id }));
		return cursor === undefined
			? { ...page, facets: null, universeEmpty: log.length === 0 }
			: { ...page, facets: null, universeEmpty: null };
	};
}

/** Renders the waivers panel alone, with a fresh query client. */
function renderWaivers() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<EvidenceWaivers org="acme" />, { wrapper });
}

beforeEach(() => {
	url.search = "";
	rpc.calls.length = 0;
	for (const k of Object.keys(rpc.handlers)) delete rpc.handlers[k];
	rpc.handlers["evidence.page"] = () => new Promise(() => {});
	rpc.handlers["evidence.waivers"] = () => new Promise(() => {});
	sessionStorage.clear();
	useEvidenceFilters.getState().reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("evidence drawer URL state (R6 C-32)", () => {
	it("a link naming an environment and a tab opens the drawer on that tab", async () => {
		url.search = "selected=e1&tab=drift";
		renderPage(result(1));
		await act(async () => {});
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByRole("tab", { name: "Drift" })).toHaveAttribute("aria-selected", "true");
	});

	it("opening a row writes the selection and its default tab into the address bar", async () => {
		const replace = vi.spyOn(window.history, "replaceState");
		renderPage(result(1));
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "payments-prod" }));
		const written = replace.mock.calls.map((c) => String(c[2]));
		expect(written.some((href) => href.includes("selected=e1") && href.includes("tab=drift"))).toBe(true);
	});

	it("an unknown tab in the URL falls back to the row's default", async () => {
		url.search = "selected=e1&tab=nonsense";
		renderPage(result(1));
		await act(async () => {});
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByRole("tab", { name: "Drift" })).toHaveAttribute("aria-selected", "true");
	});
});

describe("recorded waivers — keyset paging (#7488)", () => {
	it("walks past the old 100-row cap: the 101st waiver and the last are reachable, ties included", async () => {
		const total = 130;
		const log = Array.from({ length: total }, (_, i) => waiver(i, total));
		rpc.handlers["evidence.waivers"] = serveWaivers(log);
		renderWaivers();

		expect(await screen.findByText("reason 0")).toBeInTheDocument();
		expect(screen.queryByText("reason 50")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("reason 99")).toBeInTheDocument();
		expect(screen.queryByText("reason 100")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		// Waiver 101 (index 100) — the first row the old `.limit(100)` read could never return.
		expect(await screen.findByText("reason 100")).toBeInTheDocument();
		expect(screen.getByText(`reason ${total - 1}`)).toBeInTheDocument();

		// Every waiver exactly once, in order: no row skipped or repeated across a tied boundary.
		const reasons = screen.getAllByText(/^reason \d+$/).map((el) => el.textContent);
		expect(reasons).toEqual(log.map((w) => w.reason));

		// The end is nothing: no "Load more", no "That's all", no count.
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		const cursors = rpc.calls.filter((c) => c.path === "evidence.waivers").map((c) => c.input);
		expect(cursors).toHaveLength(3);
		expect(cursors[0]).toEqual({});
	});

	it("carries no count pill, no truncation notice and no page numbers", async () => {
		const log = Array.from({ length: 60 }, (_, i) => waiver(i, 60));
		rpc.handlers["evidence.waivers"] = serveWaivers(log);
		const { container } = renderWaivers();
		await screen.findByText("reason 0");
		expect(screen.queryByText(/most recent/i)).toBeNull();
		expect(screen.queryByText(/^Page \d+ of \d+$/)).toBeNull();
		expect(screen.queryByText(/^\d+$/)).toBeNull();
		expect(screen.queryByText("active")).toBeNull();
		expect(screen.queryByRole("navigation", { name: "Recorded waivers pages" })).toBeNull();
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
	});

	it("a failed later page keeps every loaded waiver and offers a retry", { timeout: 10_000 }, async () => {
		const log = Array.from({ length: 60 }, (_, i) => waiver(i, 60));
		const serve = serveWaivers(log);
		let failing = true;
		rpc.handlers["evidence.waivers"] = async (input) => {
			const later = typeof input === "object" && input !== null && "cursor" in input;
			if (later && failing) throw new Error("boom");
			return serve(input);
		};
		renderWaivers();
		await screen.findByText("reason 0");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		// The hook retries a real failure once (TanStack's first back-off is 1s) before it is told.
		expect(await screen.findByText("Couldn't load more", undefined, { timeout: RETRIED })).toBeInTheDocument();
		expect(screen.getByText("reason 49")).toBeInTheDocument();
		failing = false;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("reason 59")).toBeInTheDocument();
		expect(screen.getByText("reason 0")).toBeInTheDocument();
	});

	it("an empty log is the empty state, with no footer", async () => {
		rpc.handlers["evidence.waivers"] = serveWaivers([]);
		renderWaivers();
		expect(await screen.findByText("No waivers")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a failed first page is the region error, and its retry reads again", { timeout: 10_000 }, async () => {
		let failing = true;
		const serve = serveWaivers([waiver(0, 1)]);
		rpc.handlers["evidence.waivers"] = async (input) => {
			if (failing) throw new Error("boom");
			return serve(input);
		};
		renderWaivers();
		expect(await screen.findByText("Couldn't load the waivers", undefined, { timeout: RETRIED })).toBeInTheDocument();
		failing = false;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("reason 0")).toBeInTheDocument();
	});
});
