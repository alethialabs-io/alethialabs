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
import { act, render, screen } from "@testing-library/react";
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
import type { EvidenceResult } from "@/lib/rpc/procedures/evidence";

/** The key the route prefetches for a link with no filters — what the client reads first. */
const FIRST_KEY = [["evidence", "page"], { input: {}, type: "query" }];

/** A result listing one environment ("payments-prod") with no proof yet. */
function result(environments: number): EvidenceResult {
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
		groups: rows.length ? [{ key: "p1", label: "payments", rows, provider: "aws" }] : [],
		resultCount: rows.length,
		total: rows.length,
		waivers: [],
		summary: {
			environments: rows.length,
			verified: 0,
			warning: 0,
			failing: 0,
			notEvaluable: 0,
			unverified: rows.length,
			inSync: 0,
			drifted: 0,
			driftUnknown: rows.length,
			activeWaivers: 0,
			criticalHighVulns: 0,
			securityUnknown: rows.length,
		},
		statusOptions: [],
		stageOptions: [],
		providerOptions: [],
	};
}

/** Renders the page under the console's query defaults; `seed` plays the route's hydration. */
function renderPage(seed?: EvidenceResult) {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
	if (seed) qc.setQueryData(FIRST_KEY, seed);
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
		expect(rpc.calls, "nothing was fetched for first-paint data").toEqual([]);
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
		expect(await screen.findByText("You can't view evidence here", undefined, { timeout: 500 })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load evidence")).toBeNull();
		expect(screen.queryByText("No environments yet")).toBeNull();
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
			await qc.refetchQueries();
		});
		expect(screen.getByRole("button", { name: "payments-prod" })).toBeInTheDocument();
		expect(await screen.findByText(/Couldn't refresh/, undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load evidence")).toBeNull();
	});
});
