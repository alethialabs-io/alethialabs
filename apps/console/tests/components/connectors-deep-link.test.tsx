// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the connectors board's `?connect=<slug>` deep link (elench's connect action). Once the board
// says the viewer may connect, it opens that connector's connect flow once and clears the param. The
// flow's UI state is now set while rendering and only its side effects run in the effect, so these
// pin what the effect used to do in one place.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";

const h = vi.hoisted(() => ({
	board: {} as Record<string, unknown>,
	params: "",
	replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: h.replace, push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/connectors",
	useSearchParams: () => new URLSearchParams(h.params),
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
vi.mock("@/lib/query/use-connectors-query", () => ({ useConnectorsQuery: () => h.board }));

import { ConnectorsPage } from "@/components/connectors/connectors-page";

/** One api-key connector from the catalog, in a given status. */
function datadog(status: ConnectorWithConnection["status"]): ConnectorWithConnection {
	return {
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
		status,
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "observability",
	};
}

/** A settled board holding one connector, for a viewer who may (or may not) connect. */
function settle(connector: ConnectorWithConnection, canManage: boolean): void {
	h.board = {
		isPending: false,
		isError: false,
		isRefetching: false,
		error: null,
		refetch: vi.fn(),
		data: {
			integrations: [connector],
			view: { query: {}, rows: [connector], facets: { groups: [], health: [], vendors: [] }, total: 1 },
			canManage,
			platformConfigured: {},
		},
	};
}

/** Renders the board under a fresh client. */
function renderBoard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<ConnectorsPage orgSlug="acme" />, { wrapper });
}

beforeEach(() => {
	h.params = "connect=datadog";
	h.replace.mockReset();
});

describe("ConnectorsPage — the ?connect= deep link", () => {
	it("opens the connector's connect sheet once and clears the param", () => {
		settle(datadog("active"), true);
		const { rerender } = renderBoard();

		expect(screen.getByText("Connect Datadog")).toBeTruthy();
		expect(h.replace).toHaveBeenCalledWith("/acme/~/connectors", { scroll: false });

		rerender(<ConnectorsPage orgSlug="acme" />);
		expect(h.replace).toHaveBeenCalledTimes(1);
	});

	it("clears the param but opens nothing for a connector that is not available yet", () => {
		settle(datadog("coming_soon"), true);
		renderBoard();

		expect(screen.queryByText("Connect Datadog")).toBeNull();
		expect(h.replace).toHaveBeenCalledTimes(1);
	});

	it("waits for a viewer who may connect", () => {
		settle(datadog("active"), false);
		renderBoard();

		expect(screen.queryByText("Connect Datadog")).toBeNull();
		expect(h.replace).not.toHaveBeenCalled();
	});
});
