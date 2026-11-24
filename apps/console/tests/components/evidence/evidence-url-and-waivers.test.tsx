// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (R6 C-32, C-36). The evidence drawer and its tab are URL state: a link carrying
// `?selected=<env>&tab=<tab>` opens on that drawer and tab, and opening a row writes both in place.
// The recorded-waivers panel pages its rows instead of rendering the read's hundred at once.

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
const { EvidenceWaivers, WAIVER_PAGE_SIZE } = await import("@/components/evidence/evidence-waivers");
const { useEvidenceFilters } = await import("@/lib/stores/use-evidence-filters");
import type { EvidenceWaiver } from "@/lib/queries/evidence";
import type { EvidenceResult } from "@/lib/rpc/procedures/evidence";

/** The key the route prefetches for a link with no filters. */
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

/** Renders the page with its read hydrated. */
function renderPage(seed: EvidenceResult) {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
	qc.setQueryData(FIRST_KEY, seed);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<EvidenceClient />, { wrapper });
}

/** One recorded waiver with the given index. */
function waiver(i: number): EvidenceWaiver {
	return {
		jobId: `job-${i}`,
		projectName: `project-${i}`,
		environmentName: null,
		controls: [],
		reason: `reason ${i}`,
		by: "ada@example.com",
		expiry: null,
		active: true,
		createdAt: "2026-06-01T00:00:00.000Z",
	};
}

beforeEach(() => {
	url.search = "";
	rpc.calls.length = 0;
	for (const k of Object.keys(rpc.handlers)) delete rpc.handlers[k];
	rpc.handlers["evidence.page"] = () => new Promise(() => {});
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

describe("recorded waivers paging (R6 C-36)", () => {
	it("shows one page at a time and steps through the rest", () => {
		const total = WAIVER_PAGE_SIZE + 5;
		render(<EvidenceWaivers org="acme" waivers={Array.from({ length: total }, (_, i) => waiver(i))} />);
		expect(screen.getByText("reason 0")).toBeInTheDocument();
		expect(screen.queryByText(`reason ${WAIVER_PAGE_SIZE}`)).toBeNull();
		expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next page of waivers" }));
		expect(screen.getByText(`reason ${WAIVER_PAGE_SIZE}`)).toBeInTheDocument();
		expect(screen.queryByText("reason 0")).toBeNull();
	});

	it("a list that fits one page has no pager", () => {
		render(<EvidenceWaivers org="acme" waivers={[waiver(1)]} />);
		expect(screen.queryByRole("navigation", { name: "Recorded waivers pages" })).toBeNull();
	});
});
