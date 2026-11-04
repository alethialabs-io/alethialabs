// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's four renders (#6124, RUBRIC B3/B4): pending is the board-shaped skeleton,
// a refused read is its own state, a failed read is a region error with a retry, and data is the
// board — an error is never an empty board, and pending is never "No connectors match". Also: the
// board sets no timer (the 30 s `router.refresh()` loop is gone; the bus keeps it live).

import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { AppRouter } from "@/lib/rpc/router";

const board = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh }),
	usePathname: () => "/acme/~/connectors",
	useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/app/server/actions/connectors", () => ({
	deleteConnectorCredential: vi.fn(),
	saveConnectorCredential: vi.fn(),
}));
vi.mock("@/app/server/actions/identities", () => ({
	deleteProviderToken: vi.fn(),
	disconnectCloudAccount: vi.fn(),
	renameCloudAccount: vi.fn(),
	verifyCloudAccount: vi.fn(),
	connectCloudAccount: vi.fn(),
	startCloudConnect: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/query/use-connectors-query", () => ({ useConnectorsQuery: () => board.state }));

import { ConnectorsPage } from "@/components/connectors/connectors-page";

/** One observability connector from the catalog. */
const datadog: ConnectorWithConnection = {
	id: "c-datadog",
	slug: "datadog",
	name: "Datadog",
	description: "Datadog.",
	category: "observability",
	auth_method: "api_key",
	organization: "Datadog, Inc.",
	icon_url: "/icons/datadog.png",
	docs_url: null,
	support_url: null,
	privacy_url: null,
	status: "active",
	sort_order: 0,
	created_at: null,
	updated_at: null,
	connected: false,
	connection_details: null,
	group: "observability",
};

/** Renders the board under a fresh client. */
function renderBoard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<ConnectorsPage orgSlug="acme" />, { wrapper });
}

/**
 * The error the REAL browser client throws when the read route answers `status` with plain JSON —
 * how the route refuses a request with no session (401) or an actor it will not serve (403), before
 * any procedure runs. Non-defined: it carries only the status.
 */
async function wireError(status: number, error: string): Promise<unknown> {
	const client: RouterClient<AppRouter> = createORPCClient(
		new RPCLink({
			url: "http://console.test/acme/~/rpc",
			method: () => "GET",
			fetch: async () => Response.json({ error }, { status }),
		}),
	);
	return client.connectors.board({}).then(
		() => {
			throw new Error("the read was expected to fail");
		},
		(thrown: unknown) => thrown,
	);
}

/** The board's data with one connector on it. */
const boardData = {
	integrations: [datadog],
	view: { query: {}, rows: [datadog], facets: { groups: [], health: [], vendors: [] }, total: 1 },
	canManage: false,
	platformConfigured: {},
};

const settled = { isPending: false, isError: false, isRefetching: false, data: undefined, error: null, refetch: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ConnectorsPage — the four renders of its read", () => {
	it("pending: the board-shaped skeleton, never the empty state", () => {
		board.state = { ...settled, isPending: true };
		const { container } = renderBoard();
		expect(container.querySelector('[data-slot="connectors-skeleton"]')).not.toBeNull();
		expect(screen.queryByText("No connectors match")).toBeNull();
	});

	it("failed: a region error with a retry — not an empty board, not a skeleton", () => {
		board.state = { ...settled, isError: true, error: new Error("boom") };
		const { container } = renderBoard();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load connectors");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText("No connectors match")).toBeNull();
		expect(container.querySelector('[data-slot="connectors-skeleton"]')).toBeNull();
	});

	it("refused: its own state, distinct from the failure", () => {
		board.state = { ...settled, isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) };
		renderBoard();
		expect(screen.getByText("Sign in again to see connectors")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("a failed REFRESH keeps the board and says it may be stale — not blank, not the region error", () => {
		const refetch = vi.fn();
		board.state = {
			...settled,
			isError: true,
			error: new Error("boom"),
			refetch,
			data: {
				integrations: [datadog],
				view: { query: {}, rows: [datadog], facets: { groups: [], health: [], vendors: [] }, total: 1 },
				canManage: false,
				platformConfigured: {},
			},
		};
		renderBoard();
		expect(screen.getAllByText("Datadog").length).toBeGreaterThan(0);
		expect(screen.getByText("Couldn't refresh — showing earlier data")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load connectors")).toBeNull();
		screen.getByRole("button", { name: "Try again" }).click();
		expect(refetch).toHaveBeenCalled();
	});

	it("data: the board, with no timer and no route refresh", () => {
		const setInterval = vi.spyOn(globalThis, "setInterval");
		board.state = {
			...settled,
			data: {
				integrations: [datadog],
				view: { query: {}, rows: [datadog], facets: { groups: [], health: [], vendors: [] }, total: 1 },
				canManage: false,
				platformConfigured: {},
			},
		};
		renderBoard();
		expect(screen.getAllByText("Datadog").length).toBeGreaterThan(0);
		expect(setInterval).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		setInterval.mockRestore();
	});
});

describe("ConnectorsPage — the read route's own plain-JSON answers", () => {
	let unauthorized: unknown;
	let forbidden: unknown;
	let internal: unknown;

	beforeAll(async () => {
		unauthorized = await wireError(401, "Unauthorized");
		forbidden = await wireError(403, "Forbidden");
		internal = await wireError(500, "Internal");
	});

	/** Asserts the rest of the refused render: no region error, and no retry. */
	function expectNoRegionErrorOrRetry() {
		expect(screen.queryByText("Couldn't load connectors")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	}

	it("a plain 401 (session expired) renders the refused state, not the region error", () => {
		board.state = { ...settled, isError: true, error: unauthorized };
		renderBoard();
		expect(screen.getByText("Sign in again to see connectors")).toBeInTheDocument();
		expectNoRegionErrorOrRetry();
	});

	it("a plain 403 renders the refused state", () => {
		board.state = { ...settled, isError: true, error: forbidden };
		renderBoard();
		expect(screen.getByText("Sign in again to see connectors")).toBeInTheDocument();
		expectNoRegionErrorOrRetry();
	});

	it("a plain 500 is still a region error with a retry", () => {
		board.state = { ...settled, isError: true, error: internal };
		renderBoard();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load connectors");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByText("Sign in again to see connectors")).toBeNull();
	});

	it("a typed FORBIDDEN is still refused", () => {
		board.state = { ...settled, isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) };
		renderBoard();
		expect(screen.getByText("Sign in again to see connectors")).toBeInTheDocument();
		expectNoRegionErrorOrRetry();
	});

	it("a REFUSED refresh behind the board keeps the cards and offers no retry that cannot work", () => {
		board.state = { ...settled, isError: true, error: unauthorized, data: boardData };
		renderBoard();
		expect(screen.getAllByText("Datadog").length).toBeGreaterThan(0);
		expect(screen.getByText("Sign in again to refresh — showing earlier data")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});
});
