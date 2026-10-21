// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's four renders (#6124, RUBRIC B3/B4): pending is the board-shaped skeleton,
// a refused read is its own state, a failed read is a region error with a retry, and data is the
// board — an error is never an empty board, and pending is never "No connectors match". Also: the
// board sets no timer (the 30 s `router.refresh()` loop is gone; the bus keeps it live).

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";

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
vi.mock("@/components/connectors/connectors-board", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/connectors/connectors-board")>();
	return { ...actual, useConnectorsBoard: () => board.state };
});

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
		expect(screen.getByText("You can't see connectors here")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("data: the board, with no timer and no route refresh", () => {
		const setInterval = vi.spyOn(globalThis, "setInterval");
		board.state = {
			...settled,
			data: { integrations: [datadog], canManage: false, platformConfigured: {} },
		};
		renderBoard();
		expect(screen.getAllByText("Datadog").length).toBeGreaterThan(0);
		expect(setInterval).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		setInterval.mockRestore();
	});
});
