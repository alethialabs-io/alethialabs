// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6120 — the Environments page reads `environments.overview` (prefetched by the route) and renders
// its four states distinctly (RUBRIC B3/B4): pending is the route's own skeleton, a refusal is a
// refusal (forbidden, or a project that is not there), a failure is an error with a retry, and only
// data renders the page. With data, the page opens with the toolbar — the count, one line of
// description, the actions — and NO page title (F010): the sidebar and the breadcrumb name the page.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler> }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/projects", () => ({
	addEnvironment: vi.fn(),
	deleteEnvironment: vi.fn(),
	duplicateEnvironment: vi.fn(),
	setAutoHeal: vi.fn(),
}));
vi.mock("@/app/server/actions/promotions", () => ({
	approvePromotion: vi.fn(),
	cancelPromotion: vi.fn(),
	promoteEnvironment: vi.fn(),
	rejectPromotion: vi.fn(),
}));
vi.mock("@/app/server/actions/protection", () => ({ setProtectionRules: vi.fn() }));
// The classification chips are their own unit's read; here they are empty.
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));

import { EnvironmentsView } from "@/components/environments/environments-view";
import { orpc } from "@/lib/rpc/client";
import type { EnvironmentsOverview } from "@/lib/rpc/procedures/environments";

const KEY = orpc.environments.overview.queryKey({ input: { project: "payments" } });

/** A project with two environments, nothing in flight, nothing promoted yet. */
const OVERVIEW: EnvironmentsOverview = {
	projectId: "11111111-1111-4111-8111-111111111111",
	envs: [
		{ id: "env-dev", name: "development", stage: "development", is_default: true, updated_at: "2026-10-01T00:00:00.000Z" },
		{ id: "env-prod", name: "production", stage: "production", is_default: false, updated_at: "2026-10-02T00:00:00.000Z" },
	],
	consistency: { envs: [], rows: [] },
	reconcile: [],
	promotions: [],
	activePromotion: null,
	protectionByEnv: {},
};

/** Renders the view over a cache `seed` prepared — the state the route's prefetch handed over. */
function renderView(seed: (qc: QueryClient) => void) {
	// staleTime / retryOnMount: the cached entry IS the server's answer; the test is about rendering
	// it, not refetching. (An errored entry with no data is refetched on mount by default, and a
	// refetch of a never-successful query resets it to pending — the render under test would vanish.)
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } },
	});
	seed(qc);
	return render(
		<QueryClientProvider client={qc}>
			<EnvironmentsView org="acme" project="payments" />
		</QueryClientProvider>,
	);
}

/** Seeds the overview read as failed with `error` (what a refused or failed prefetch leaves). */
function failed(error: Error) {
	return (qc: QueryClient) =>
		qc.getQueryCache().build(qc, { queryKey: KEY }).setState({
			status: "error",
			error,
			fetchStatus: "idle",
		});
}

describe("EnvironmentsView — the data (F010)", () => {
	it("opens with the toolbar — the count, the description, the actions — and no page title", () => {
		renderView((qc) => qc.setQueryData(KEY, OVERVIEW));
		const toolbar = document.querySelector('[data-slot="page-toolbar"]');
		expect(toolbar).not.toBeNull();
		expect(toolbar).toHaveTextContent("2");
		expect(toolbar).toHaveTextContent("Isolated instances of this project's services.");
		expect(screen.getByRole("button", { name: /new environment/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /promote/i })).toBeInTheDocument();
		// No heading says what the breadcrumb already says.
		expect(screen.queryByRole("heading", { name: /^environments/i })).toBeNull();
		expect(screen.getByRole("link", { name: "development" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "production" })).toBeInTheDocument();
	});

	it("renders an empty project as empty — the toolbar still offers to create one", () => {
		renderView((qc) => qc.setQueryData(KEY, { ...OVERVIEW, envs: [] }));
		expect(screen.getByText("No environments")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /new environment/i })).toBeInTheDocument();
	});
});

describe("EnvironmentsView — pending, refused and failed are distinct (B3/B4)", () => {
	it("pending is the skeleton — never the empty state", () => {
		h.handlers["environments.overview"] = () => new Promise(() => {});
		renderView(() => {});
		expect(document.body.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText("No environments")).toBeNull();
	});

	it("a FORBIDDEN refusal reads as a permission, not as no environments", () => {
		renderView(failed(new ORPCError("FORBIDDEN", { defined: true })));
		expect(document.body.querySelector('[data-state="forbidden"]')).not.toBeNull();
		expect(screen.queryByText("No environments")).toBeNull();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("a NOT_FOUND refusal reads as a project that is not here", () => {
		renderView(failed(new ORPCError("NOT_FOUND", { defined: true })));
		expect(document.body.querySelector('[data-state="not-found"]')).not.toBeNull();
		expect(screen.queryByText("No environments")).toBeNull();
	});

	it("any other failure is an error with a retry — not empty, not an endless skeleton", () => {
		renderView(failed(new Error("network")));
		expect(screen.getByText("Couldn't load environments")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
		expect(screen.queryByText("No environments")).toBeNull();
		expect(document.body.querySelector('[aria-busy="true"]')).toBeNull();
	});
});
