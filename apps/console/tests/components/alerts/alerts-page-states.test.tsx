// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6125 — the Alerts hub reads its settings over `alerts.settings`, and each answer is its own render
// (RUBRIC B4): the hub with its sections; the no-access notice for a FORBIDDEN refusal; a region error
// with a retry for a failure; the upsell when the plan no longer includes alerting. The route
// prefetches the settings, so these are what a tab sees when a permission or a plan changes under it.
// And with the reads in the cache — as the route's prefetch hands them over — the hub paints its rows
// with no read issued on mount (B1).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/alerts",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/alerts", () =>
	Object.fromEntries(
		[
			"addChannel",
			"createPolicy",
			"deleteChannel",
			"deletePolicy",
			"setChannelEnabled",
			"togglePolicy",
			"updateChannel",
			"updatePolicy",
			"verifyChannel",
		].map((name) => [name, vi.fn()]),
	),
);
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: ({ feature }: { feature: string }) => <div>upsell:{feature}</div>,
}));

import { ORPCError } from "@orpc/client";
import { AlertsPage } from "@/components/alerts/alerts-page";

const SETTINGS = {
	alerting: true,
	advancedAlerting: false,
	canManage: false,
	encryptionConfigured: true,
	categories: [],
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
};

/** An empty list page. */
const EMPTY_PAGE = { rows: [], resultCount: 0, total: 0, facets: { status: [], kinds: [], channels: [], types: [] } };

/** Renders the hub over a fresh client; `seed` puts answers in the cache first, as the prefetch does. */
function renderHub(seed?: (client: QueryClient) => void) {
	// The console's own staleTime (lib/query/client.ts): fresh prefetched data is not refetched on mount.
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	seed?.(client);
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return render(<AlertsPage />, { wrapper: Wrapper });
}

/** The dotted procedure paths the hub READ (a cache hit reads nothing). */
function readPaths(): string[] {
	return h.calls.map((c) => c.path);
}

// The hub's scroll-spy: jsdom has neither, and neither is under test here.
vi.stubGlobal(
	"IntersectionObserver",
	class {
		observe() {}
		disconnect() {}
	},
);
Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
	h.calls.length = 0;
	h.handlers["alerts.settings"] = async () => SETTINGS;
	h.handlers["alerts.policies"] = async () => EMPTY_PAGE;
	h.handlers["alerts.channels"] = async () => EMPTY_PAGE;
	h.handlers["alerts.deliveries"] = async () => EMPTY_PAGE;
});

describe("AlertsPage — the settings read's four answers", () => {
	it("answered: the three sections, each with its own answer", async () => {
		renderHub();
		expect(await screen.findByText("No policies yet")).toBeInTheDocument();
		expect(screen.getByText("No channels yet")).toBeInTheDocument();
		expect(screen.getByText("No activity yet")).toBeInTheDocument();
	});

	it("forbidden: the no-access notice — not an error, not empty", async () => {
		h.handlers["alerts.settings"] = async () => {
			throw new ORPCError("FORBIDDEN", { defined: true });
		};
		renderHub();
		expect(await screen.findByText("No access to alerts")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load alerts")).toBeNull();
		expect(screen.queryByText("No policies yet")).toBeNull();
	});

	it("failed: a region error with a retry — not the no-access notice, not empty", async () => {
		h.handlers["alerts.settings"] = async () => {
			throw new Error("boom");
		};
		renderHub();
		expect(await screen.findByText("Couldn't load alerts")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText("No access to alerts")).toBeNull();
		expect(screen.queryByText("No policies yet")).toBeNull();
	});

	it("plan gone: the upsell", async () => {
		h.handlers["alerts.settings"] = async () => ({ ...SETTINGS, alerting: false });
		renderHub();
		expect(await screen.findByText("upsell:alerting")).toBeInTheDocument();
	});

	it("pending: the hub's skeleton, and no section's empty copy", () => {
		h.handlers["alerts.settings"] = () => new Promise(() => {});
		const { container } = renderHub();
		expect(container.querySelector('[data-slot="alerts-panel-skeleton"]')).not.toBeNull();
		expect(screen.queryByText("No policies yet")).toBeNull();
	});
});

describe("AlertsPage — first paint from the prefetched cache (B1)", () => {
	it("paints every section from the cache and issues no read on mount", async () => {
		renderHub((client) => {
			client.setQueryData([["alerts", "settings"], { input: undefined, type: "query" }], SETTINGS);
			for (const list of ["policies", "channels", "deliveries"]) {
				client.setQueryData([["alerts", list], { input: {}, type: "query" }], EMPTY_PAGE);
			}
		});
		expect(screen.getByText("No policies yet")).toBeInTheDocument();
		expect(screen.getByText("No activity yet")).toBeInTheDocument();
		// Give any mount effect a turn to fire a read.
		await waitFor(() => expect(readPaths()).toEqual([]));
	});
});
