// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6843 — the one-screen create. What the issue asks, one test each:
//   - a connected account is selected without a click, and the name is filled in;
//   - the four offered clouds are shown, and a connected cloud that is not offered is said, not offered;
//   - connecting a cloud in place selects it;
//   - Create is disabled with a reason while a scan runs;
//   - a refusal carries a field: the name when the name is at fault, the cloud account when it is;
//   - a reload keeps the starting point, the name and the cloud;
//   - Create lands on the canvas through `canvasHandoffHref`, with the seed, and cannot be pressed twice.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { ScanResult } from "@/components/create-project/use-create-project-reads";
import type { ConnectedAccount } from "@/lib/projects/connected-account";
import { orpc } from "@/lib/rpc/client";

vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/support/submit-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});

const { push, page, tryCreateProject, toastError, connect, reads } = vi.hoisted(() => ({
	push: vi.fn(),
	page: { search: "" },
	tryCreateProject: vi.fn(),
	toastError: vi.fn(),
	connect: {
		onConnected: null as ((account: ConnectedAccount) => void) | null,
		openConnect: vi.fn(async () => undefined),
	},
	reads: {
		scan: null as ScanResult | null,
		availability: undefined as { available: boolean; slug: string } | undefined,
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/new",
	useSearchParams: () => new URLSearchParams(page.search),
}));
vi.mock("@/app/server/actions/projects", () => ({
	tryCreateProject: (...args: unknown[]) => tryCreateProject(...args),
}));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() } }));
vi.mock("@/components/cloud-connect/use-cloud-connect", () => ({
	useCloudConnect: (args: { onConnected?: (account: ConnectedAccount) => void }) => {
		connect.onConnected = args.onConnected ?? null;
		return { openConnect: connect.openConnect, connectingSlug: null, sheets: null };
	},
}));
vi.mock("@/components/create-project/use-create-project-reads", () => ({
	useScanResult: (jobId: string | null) => ({
		result: jobId === null ? null : reads.scan,
		retry: vi.fn(),
		reread: vi.fn(),
	}),
	useNameAvailability: (_name: string, enabled: boolean) => ({
		availability: enabled ? reads.availability : undefined,
		checking: false,
		failed: false,
	}),
	useLinkedGitProviders: () => ({ data: [] }),
}));
vi.mock("@/components/create-project/repo-import-panel", () => ({
	RepoImportPanel: () => <p>repository picker</p>,
}));

const { CreateProjectScreen } = await import("@/components/create-project/create-project-screen");
const { resetTestPage } = await import("@/tests/components/support/submit-wizard-harness");

const HZ = "11111111-1111-4111-8111-111111111111";
const NEW_AWS = "22222222-2222-4222-8222-222222222222";
const JOB = "00000000-0000-4000-8000-0000000000aa";

/** A cloud connector; `accounts` empty means not connected. */
function cloud(slug: string, name: string, accounts: ConnectorWithConnection["accounts"] = []) {
	return {
		id: `c-${slug}`,
		slug,
		name,
		category: "cloud",
		connected: (accounts ?? []).length > 0,
		connection_details: null,
		group: "clouds",
		accounts,
	};
}

/** The connectors list: Hetzner connected, AWS not, and Alibaba connected but not offered. */
const INTEGRATIONS = [
	cloud("aws", "Amazon Web Services"),
	cloud("gcp", "Google Cloud"),
	cloud("azure", "Microsoft Azure"),
	cloud("hetzner", "Hetzner", [{ identityId: HZ, name: "hz-main", status: "connected" }]),
	cloud("alibaba", "Alibaba Cloud", [{ identityId: "x", name: "ali", status: "connected" }]),
];

/** Renders the screen; returns its query client. */
function renderScreen(
	options: {
		integrations?: unknown[];
		initialSource?: "blank" | "standard" | null;
		client?: QueryClient;
		/** What the refusal's re-check of the name answers. */
		nameTaken?: boolean;
	} = {},
) {
	const client =
		options.client ??
		new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } });
	client.setQueryData([...orpc.workspace.projects.queryKey()], []);
	// The re-check a refusal makes of the name, answered here rather than over the network.
	if (!vi.isMockFunction(client.fetchQuery)) {
		vi.spyOn(client, "fetchQuery").mockResolvedValue({ available: !options.nameTaken, slug: "my-first-project" });
	}
	const utils = render(
		<QueryClientProvider client={client}>
			<CreateProjectScreen
				orgSlug="acme"
				offered={["aws", "gcp", "azure", "hetzner"]}
				integrations={(options.integrations ?? INTEGRATIONS) as unknown as ConnectorWithConnection[]}
				canManage
				awsSetup={null}
				gcpSetup={null}
				azureSetup={null}
				byoHelmEnabled={false}
				byoIacEnabled={false}
				providerAvailability={{ github: true, gitlab: false, bitbucket: false }}
				initialSource={options.initialSource ?? null}
			/>
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

/** The Create button, once the form has read its draft (until then the form is drawn inert and busy). */
async function createButton() {
	const button = await screen.findByRole("button", { name: "Create project" });
	await waitFor(() => expect(document.querySelector('form[aria-busy="true"]')).toBeNull());
	return button;
}

beforeEach(() => {
	vi.clearAllMocks();
	resetTestPage();
	page.search = "";
	reads.scan = null;
	reads.availability = undefined;
	connect.onConnected = null;
});

describe("CreateProjectScreen — what it works out", () => {
	it("selects the connected account without a click and fills in the name", async () => {
		renderScreen();
		await createButton();
		expect(screen.getByRole("radio", { name: /Hetzner/ })).toBeChecked();
		expect(screen.getByText("hz-main")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("my-first-project");
		expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
	});

	it("shows the four offered clouds and says why a connected Alibaba account is not one of them", async () => {
		renderScreen();
		await createButton();
		const clouds = screen.getAllByRole("radio").filter((radio) => radio.getAttribute("name") === "provider");
		expect(clouds.map((radio) => radio.getAttribute("value"))).toEqual(["aws", "gcp", "azure", "hetzner"]);
		expect(screen.getByText(/Alibaba Cloud: Not available for new projects/)).toBeInTheDocument();
	});

	it("asks nothing about a cloud for a blank project", async () => {
		renderScreen({ initialSource: "blank" });
		await createButton();
		expect(screen.queryAllByRole("radio").filter((radio) => radio.getAttribute("name") === "provider")).toEqual([]);
	});
});

describe("CreateProjectScreen — connecting in place", () => {
	it("selects an account connected from the screen, on its cloud", async () => {
		const user = userEvent.setup();
		renderScreen();
		await createButton();
		await user.click(screen.getByRole("radio", { name: /AWS/ }));
		await user.click(screen.getByRole("button", { name: "Connect AWS" }));
		expect(connect.openConnect).toHaveBeenCalledTimes(1);
		act(() => {
			connect.onConnected?.({ identityId: NEW_AWS, provider: "aws" } as ConnectedAccount);
		});
		await waitFor(() => expect(screen.getByText("AWS account")).toBeInTheDocument());
		expect(screen.getByRole("radio", { name: /AWS/ })).toBeChecked();
	});
});

describe("CreateProjectScreen — an import", () => {
	it("keeps Create disabled, with the reason, while the scan runs", async () => {
		page.search = `scan=${JOB}`;
		reads.scan = { status: "PENDING", jobStatus: "RUNNING" };
		renderScreen();
		const create = await createButton();
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription(/still running/);
		expect(screen.getByRole("radio", { name: /Import a repository/ })).toBeChecked();
	});
});

describe("CreateProjectScreen — creating", () => {
	it("creates a production-only project and lands on the canvas with the template seed", async () => {
		tryCreateProject.mockResolvedValue({ ok: true, project: { id: "p1", slug: "my-first-project" } });
		const user = userEvent.setup();
		renderScreen();
		await user.click(await createButton());
		await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
		const [input] = tryCreateProject.mock.calls[0] ?? [];
		expect(input.project.cloud_identity_id).toBe(HZ);
		expect(input.project.environments.map((env: { name: string }) => env.name)).toEqual(["production"]);
		expect(push).toHaveBeenCalledWith("/acme/my-first-project/architecture?seed=v1.template.standard.hetzner");
	});

	it("cannot be submitted twice while the first create is in flight", async () => {
		tryCreateProject.mockReturnValue(new Promise(() => undefined));
		const user = userEvent.setup();
		renderScreen();
		const create = await createButton();
		await user.click(create);
		await user.click(create);
		expect(tryCreateProject).toHaveBeenCalledTimes(1);
	});

	it("puts a name refusal beside the name, once, and stays on the screen", async () => {
		const taken = 'A project named "my-first-project" already exists in this organization.';
		tryCreateProject.mockResolvedValue({ ok: false, error: taken });
		const user = userEvent.setup();
		renderScreen({ initialSource: "blank", nameTaken: true });
		await user.click(await createButton());
		const field = screen.getByRole("textbox", { name: "Project name" });
		expect(await screen.findByRole("alert")).toHaveTextContent(taken);
		expect(field).toHaveAccessibleDescription(taken);
		expect(toastError).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
	});

	it("puts a cloud-account refusal on the cloud account, not on the name", async () => {
		const refusal = "The cloud account on the project cannot be used.";
		tryCreateProject.mockResolvedValue({ ok: false, error: refusal });
		const user = userEvent.setup();
		renderScreen();
		await user.click(await createButton());
		await waitFor(() => expect(screen.getByText(refusal)).toBeInTheDocument());
		expect(screen.getByText(refusal)).toHaveAttribute("id", "cloud_account_error");
		expect(screen.getByRole("textbox", { name: "Project name" })).toHaveAttribute("aria-invalid", "false");
	});

	it("says a name the org already holds before Create, and will not submit it", async () => {
		reads.availability = { available: false, slug: "my-first-project-2" };
		renderScreen();
		const create = await createButton();
		expect(screen.getByText(/already exists in this organization/)).toBeInTheDocument();
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription("Choose another project name.");
	});
});

describe("CreateProjectScreen — a reload", () => {
	it("keeps the starting point, the name and the cloud", async () => {
		const user = userEvent.setup();
		const first = renderScreen();
		await createButton();
		await user.click(screen.getByRole("radio", { name: /AI workloads/ }));
		await user.click(screen.getByRole("radio", { name: /GCP/ }));
		const field = screen.getByRole("textbox", { name: "Project name" });
		await user.clear(field);
		await user.type(field, "rag-api");
		first.unmount();

		renderScreen();
		await createButton();
		expect(screen.getByText(/Restored your draft/)).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("rag-api");
		expect(screen.getByRole("radio", { name: /AI workloads/ })).toBeChecked();
		expect(screen.getByRole("radio", { name: /GCP/ })).toBeChecked();
	});
});
