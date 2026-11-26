// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's settled render, for what #6816 made it decide from the read alone:
//
//   · `canManage`: a viewer who may not manage connections sees the board, a line saying it is
//     read-only for them, and every Connect drawn disabled WITH the reason — not removed;
//   · `offeredClouds`: a cloud that takes no new connection keeps its card only for its existing
//     accounts — Manage, Re-verify, Rename, Disconnect — with one sentence why, and never a Connect
//     or an "Add another account";
//   · a connector that works only from a cluster in a cloud that is not offered is left out, and
//     the count is rebuilt without it;
//   · an empty catalog is not a filter that matched nothing;
//   · the layout is the link's (`?view=table`);
//   · disconnecting a cloud account that projects use names them and asks for the account's name.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";

const h = vi.hoisted(() => ({
	board: {} as Record<string, unknown>,
	params: "",
	replace: vi.fn(),
	projects: [] as unknown[],
	disconnectCloudAccount: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: h.replace, push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/connectors",
	useSearchParams: () => new URLSearchParams(h.params),
	useParams: () => ({ org: "acme" }),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"workspace.projects": async () => h.projects,
			"classification.canEdit": async () => false,
			"classification.assignments": async () => [],
			"classification.assignmentsForKind": async () => ({}),
			"classification.dimensions": async () => [],
		}).orpc,
	};
});
vi.mock("@/app/server/actions/classification/assignments", () => ({
	assignClassification: vi.fn(),
	unassignClassification: vi.fn(),
}));
vi.mock("@/app/server/actions/connectors", () => ({
	deleteConnectorCredential: vi.fn(),
	saveConnectorCredential: vi.fn(),
}));
vi.mock("@/app/server/actions/identities", () => ({
	deleteProviderToken: vi.fn(),
	disconnectCloudAccount: h.disconnectCloudAccount,
	renameCloudAccount: vi.fn(),
	verifyCloudAccount: vi.fn(),
	connectCloudAccount: vi.fn(),
	startCloudConnect: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/query/use-connectors-query", () => ({ useConnectorsQuery: () => h.board }));

import { ConnectorsPage } from "@/components/connectors/connectors-page";
import { NOT_OFFERED_SHORT, notOfferedSentence } from "@/components/connectors/connectors-query";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";

/** A catalog row with nothing connected; `over` makes it the connector a test needs. */
function connector(over: Partial<ConnectorWithConnection>): ConnectorWithConnection {
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
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "observability",
		...over,
	};
}

const datadog = connector({});

/** An offered cloud with one connected account. */
const aws = connector({
	id: "c-aws",
	slug: "aws",
	name: "Amazon Web Services",
	description: "Provision into AWS.",
	category: "cloud",
	auth_method: "iam_role",
	organization: "Amazon Web Services, Inc.",
	group: "clouds",
	connected: true,
	scope: "org",
	accounts: [{ identityId: "acc-1", name: "Prod AWS", status: "connected" }],
	connection_details: { cloud_identity_id: "acc-1" },
});

/** A cloud this deployment does not offer, on the board because the org has an account on it. */
const fixtureCloud = connector({
	id: "c-far",
	slug: "farcloud",
	name: "Far Cloud",
	description: "Provision into Far Cloud.",
	category: "cloud",
	auth_method: "ram_role",
	organization: "Far Cloud Ltd",
	group: "clouds",
	connected: true,
	scope: "org",
	accounts: [{ identityId: "far-1", name: "Old Far", status: "connected" }],
	connection_details: { cloud_identity_id: "far-1" },
});

/** A keyless store that signs in with the cluster's own identity on the cloud that is not offered. */
const farSecrets = connector({
	id: "c-far-secrets",
	slug: "far-secrets-xacct",
	name: "Far Secrets (cross-account)",
	category: "secrets",
	auth_method: "ram_role",
	organization: "Far Cloud Ltd",
	group: "secrets",
	status: "coming_soon",
});

/** The same kind of connector on an offered cloud. */
const awsRegistry = connector({
	id: "c-ecr-xacct",
	slug: "ecr-xacct",
	name: "Amazon ECR (cross-account)",
	category: "registry",
	auth_method: "iam_role",
	organization: "Amazon Web Services",
	group: "registries",
	status: "coming_soon",
});

interface BoardInput {
	integrations: ConnectorWithConnection[];
	canManage: boolean;
	offeredClouds?: string[];
	/** The server's answer for a FILTERED query, in place of the view over every row. */
	filteredTo?: { search: string; rows: ConnectorWithConnection[] };
}

/** Settles the board on `integrations`, with the server's view over all of them (or `filteredTo`). */
function settle({ integrations, canManage, offeredClouds = ["aws"], filteredTo }: BoardInput): void {
	h.board = {
		isPending: false,
		isError: false,
		isRefetching: false,
		error: null,
		refetch: vi.fn(),
		data: {
			integrations,
			view: {
				query: filteredTo ? { search: filteredTo.search } : {},
				rows: filteredTo ? filteredTo.rows : integrations,
				facets: { groups: [], health: [], vendors: [] },
				total: integrations.length,
			},
			canManage,
			platformConfigured: {},
			offeredClouds,
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
	h.params = "";
	h.projects = [];
	h.replace.mockReset();
	h.disconnectCloudAccount.mockReset();
});

describe("ConnectorsPage — a viewer who may not manage connections", () => {
	it("says the board is read-only and draws Connect disabled with the reason", () => {
		settle({ integrations: [datadog], canManage: false });
		const { container } = renderBoard();

		expect(container.querySelector('[data-slot="connectors-read-only"]')).toHaveTextContent(
			MANAGE_DENIED_REASON,
		);
		const connect = screen.getByRole("button", { name: "Connect Datadog" });
		expect(connect).toBeDisabled();
		expect(connect).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
	});

	it("draws no read-only line, and a live Connect, for a manager", () => {
		settle({ integrations: [datadog], canManage: true });
		const { container } = renderBoard();

		expect(container.querySelector('[data-slot="connectors-read-only"]')).toBeNull();
		expect(screen.getByRole("button", { name: "Connect Datadog" })).toBeEnabled();
	});
});

describe("ConnectorsPage — a cloud that takes no new connection", () => {
	it("keeps Manage, offers no Connect, and says why on the card", () => {
		settle({ integrations: [aws, fixtureCloud], canManage: true });
		renderBoard();

		expect(screen.getByRole("button", { name: "Manage Far Cloud" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Connect Far Cloud" })).toBeNull();
		expect(screen.getByText(NOT_OFFERED_SHORT)).toBeInTheDocument();
		// The offered cloud beside it is unchanged.
		expect(screen.queryByText("Provision into AWS.")).toBeInTheDocument();
	});

	it("its sheet lists the account with Re-verify, Rename and Disconnect, the sentence, and no way to add one", async () => {
		const user = userEvent.setup();
		settle({ integrations: [aws, fixtureCloud], canManage: true });
		renderBoard();

		await user.click(screen.getByRole("button", { name: "Manage Far Cloud" }));
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByText(notOfferedSentence("Far Cloud"))).toBeInTheDocument();
		expect(within(sheet).getByRole("button", { name: "Re-verify Old Far" })).toBeEnabled();
		expect(within(sheet).getByRole("button", { name: "Rename Old Far" })).toBeEnabled();
		expect(within(sheet).getByRole("button", { name: "Disconnect Old Far" })).toBeEnabled();
		expect(within(sheet).queryByRole("button", { name: /add another account/i })).toBeNull();
	});

	it("an offered cloud's sheet still offers to add an account, and carries no such sentence", async () => {
		const user = userEvent.setup();
		settle({ integrations: [aws, fixtureCloud], canManage: true });
		renderBoard();

		await user.click(screen.getByRole("button", { name: "Manage Amazon Web Services" }));
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByRole("button", { name: /add another account/i })).toBeEnabled();
		expect(sheet.querySelector('[data-slot="connector-not-offered"]')).toBeNull();
	});
});

describe("ConnectorsPage — a connector that needs a cloud that is not offered", () => {
	it("is left off the board, and no list-size pill is drawn", () => {
		settle({ integrations: [aws, awsRegistry, farSecrets, datadog], canManage: true });
		const { container } = renderBoard();

		expect(screen.queryByText("Far Secrets (cross-account)")).toBeNull();
		expect(screen.getAllByText("Amazon ECR (cross-account)").length).toBeGreaterThan(0);
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
	});
});

describe("ConnectorsPage — nothing to show", () => {
	it("an empty catalog says what a connector is and offers no filter reset", () => {
		settle({ integrations: [], canManage: true });
		renderBoard();

		expect(screen.getByText("No connectors are available")).toBeInTheDocument();
		expect(screen.queryByText("No connectors match these filters.")).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});
});

describe("ConnectorsPage — the one-row toolbar", () => {
	it("carries search, the three facets and the page's own controls, and no description line", () => {
		settle({ integrations: [datadog], canManage: true });
		const { container } = renderBoard();
		expect(container.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		expect(screen.queryByText(/Credentials Alethia acts through/)).toBeNull();
		expect(screen.getByRole("textbox", { name: "Search connectors" })).toBeInTheDocument();
		for (const facet of ["Status", "Group", "Vendor"]) {
			expect(screen.getByRole("button", { name: facet })).toBeInTheDocument();
		}
		expect(container.querySelector('[data-slot="list-toolbar-end"] a[aria-label="What are connectors?"]')).not.toBeNull();
	});

	it("filters that match nothing are the shared FilterEmpty, with a Clear filters way back", () => {
		settle({ integrations: [datadog], canManage: true, filteredTo: { search: "zzz", rows: [] } });
		renderBoard();
		expect(screen.getByText("No connectors match these filters.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
		expect(screen.queryByText("No connectors are available")).toBeNull();
	});
});

describe("ConnectorsPage — the layout is the link's", () => {
	it("draws the table for ?view=table and writes the card grid back as no param", async () => {
		const user = userEvent.setup();
		h.params = "view=table";
		settle({ integrations: [datadog], canManage: true });
		renderBoard();

		expect(screen.getByRole("table")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Card view" }));
		expect(h.replace).toHaveBeenCalledWith("/acme/~/connectors", { scroll: false });
	});

	it("draws the card grid for a link with no view, and writes the table into the URL", async () => {
		const user = userEvent.setup();
		settle({ integrations: [datadog], canManage: true });
		renderBoard();

		expect(screen.queryByRole("table")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Table view" }));
		expect(h.replace).toHaveBeenCalledWith("/acme/~/connectors?view=table", { scroll: false });
	});
});

describe("ConnectorsPage — disconnecting a cloud account", () => {
	/** Opens the AWS sheet and presses the account's Disconnect. */
	async function openDisconnect(user: ReturnType<typeof userEvent.setup>) {
		await user.click(screen.getByRole("button", { name: "Manage Amazon Web Services" }));
		const sheet = await screen.findByRole("dialog");
		await user.click(within(sheet).getByRole("button", { name: "Disconnect Prod AWS" }));
		return screen.findByRole("alertdialog");
	}

	it("names the projects that use it and stays locked until the account's name is typed", async () => {
		const user = userEvent.setup();
		h.projects = [
			{ id: "p-1", project_name: "shop", cloud_identity_id: "acc-1" },
			{ id: "p-2", project_name: "billing", cloud_identity_id: "acc-1" },
			{ id: "p-3", project_name: "elsewhere", cloud_identity_id: "other" },
		];
		h.disconnectCloudAccount.mockResolvedValue({ ok: true, data: { identityId: "acc-1" } });
		settle({ integrations: [aws], canManage: true });
		renderBoard();

		const dialog = await openDisconnect(user);
		await waitFor(() => expect(within(dialog).getByText(/2 projects use it/)).toBeInTheDocument());
		expect(within(dialog).getByText(/shop cannot be planned, deployed or destroyed/)).toBeInTheDocument();
		expect(within(dialog).getByText(/billing cannot be planned, deployed or destroyed/)).toBeInTheDocument();
		expect(within(dialog).queryByText(/elsewhere/)).toBeNull();

		const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
		expect(confirm).toBeDisabled();
		await user.type(within(dialog).getByRole("textbox"), "Prod AWS");
		expect(confirm).toBeEnabled();
		await user.click(confirm);
		await waitFor(() =>
			expect(h.disconnectCloudAccount).toHaveBeenCalledWith({ identityId: "acc-1" }),
		);
	});

	it("is a plain confirmation that says no project uses it when none does", async () => {
		const user = userEvent.setup();
		h.projects = [{ id: "p-3", project_name: "elsewhere", cloud_identity_id: "other" }];
		settle({ integrations: [aws], canManage: true });
		renderBoard();

		const dialog = await openDisconnect(user);
		await waitFor(() => expect(within(dialog).getByText(/No project uses it\./)).toBeInTheDocument());
		expect(within(dialog).queryByRole("textbox")).toBeNull();
		expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeEnabled();
	});
});
