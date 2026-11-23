// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cloud connect sheet (#6842, B-03 B-04 B-05), driven through `useCloudConnect` as a host uses it.
//
//   · One sheet serves every cloud, opened from the URL (`?wizard=cloud-connect&step=<cloud>`); a
//     cloud the server does not offer is said, never shown as a form.
//   · GCP is a form with a message per field: an empty Connect names both fields and sends nothing.
//   · The project ID typed once is written into the command to copy; a pasted script output fills
//     both ids.
//   · Connect starts the session only when pressed (or uses the host's seed), saves and verifies in
//     one press, shows the outcome with Done, and hands back a `ConnectedAccount` at once.
//   · A server field refusal is shown under its field; a failed verify is an alert with Retry, and
//     the retry saves into the same identity.
//   · The typed identifiers survive a reload; a token never reaches storage.
//   · An instance that cannot serve a keyless connect (no signing key, or an app URL no cloud can
//     reach) shows "not publicly reachable" for AWS, GCP and Azure instead of a form; Hetzner is
//     unaffected (EDN-H6).
//
// "A reload" is an unmount and a fresh render over the same query string and tab storage.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";

const h = vi.hoisted(() => ({
	start: vi.fn(),
	connect: vi.fn(),
	offered: { clouds: ["aws", "gcp", "azure", "hetzner"] },
	keyless: { readiness: { ready: true } as { ready: boolean; reason?: string } },
}));

vi.mock("next/navigation", async () => {
	const harness = await import("@/tests/components/runners/fleet-pool-wizard-harness");
	/** The query string of an href the router is given. */
	const queryOf = (href: string) => (href.includes("?") ? href.slice(href.indexOf("?") + 1) : "");
	return {
		useRouter: () => ({
			push: (href: string) => harness.setTestSearch(queryOf(href)),
			replace: (href: string) => harness.setTestSearch(queryOf(href)),
			refresh: vi.fn(),
		}),
		usePathname: () => "/acme/~/connectors",
		useSearchParams: () => {
			const { location } = harness.useTestWizardEnvironment();
			return { get: (name: string) => location.read(name), toString: () => harness.testSearch() };
		},
		useParams: () => ({ org: "acme" }),
	};
});
vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/runners/fleet-pool-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});
vi.mock("@/app/server/actions/identities", () => ({
	startCloudConnect: h.start,
	connectCloudAccount: h.connect,
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"connectors.board": async () => ({ offeredClouds: h.offered.clouds, keylessReadiness: h.keyless.readiness }),
		}).orpc,
	};
});
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn(), captureException: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { useCloudConnect } from "@/components/cloud-connect/use-cloud-connect";
import type { ConnectedAccount } from "@/lib/projects/connected-account";
import { resetTestPage, setTestSearch, testParam } from "@/tests/components/runners/fleet-pool-wizard-harness";

const STARTED = "5a4b3c2d-1e0f-4a1b-8c2d-3e4f5a6b7c8d";
const SEEDED = "0f1e2d3c-4b5a-4687-9a8b-7c6d5e4f3a2b";

/** A cloud connector card, not yet connected. */
function cloud(slug: string): ConnectorWithConnection {
	return {
		id: `c-${slug}`,
		slug,
		name: slug,
		description: slug,
		category: "cloud",
		auth_method: "iam_role",
		organization: slug,
		icon_url: `/icons/${slug}.png`,
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "clouds",
	};
}

/** A verify result. */
function verified(identityId: string, ok = true) {
	return {
		ok: true,
		data: {
			identityId,
			verified: ok,
			status: ok ? "connected" : "error",
			error: ok ? null : "The pool does not trust this issuer.",
			missingPermissions: [],
		},
	};
}

/** A host surface with one Connect button per cloud, as the connectors board uses the hook. */
function Host({
	onConnected,
	gcpSetup,
}: {
	onConnected: (account: ConnectedAccount) => void;
	gcpSetup?: { identityId: string };
}) {
	const connect = useCloudConnect({ integrations: [], refreshRouteOnClose: false, onConnected, gcpSetup });
	return (
		<>
			{["aws", "gcp", "azure", "hetzner", "alibaba"].map((slug) => (
				<button key={slug} type="button" onClick={() => void connect.openConnect(cloud(slug))}>
					{`Open ${slug}`}
				</button>
			))}
			{connect.sheets}
		</>
	);
}

/** Renders the host under a fresh client. */
function renderHost(props: { gcpSetup?: { identityId: string } } = {}) {
	const onConnected = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={client}>
			<Host onConnected={onConnected} gcpSetup={props.gcpSetup} />
		</QueryClientProvider>,
	);
	return { ...view, onConnected };
}

/** Opens the GCP sheet and waits for its first field. */
async function openGcp() {
	fireEvent.click(screen.getByRole("button", { name: "Open gcp" }));
	return screen.findByLabelText("Project ID");
}

/** Types both GCP ids. */
function typeGcpIds() {
	fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "acme-prod-1" } });
	fireEvent.change(screen.getByLabelText("Project number"), { target: { value: "123456789012" } });
}

beforeEach(() => {
	resetTestPage();
	h.start.mockReset();
	h.connect.mockReset();
	h.start.mockResolvedValue({ ok: true, data: { identityId: STARTED } });
	h.connect.mockResolvedValue(verified(STARTED));
	h.offered.clouds = ["aws", "gcp", "azure", "hetzner"];
	h.keyless.readiness = { ready: true };
});

describe("one sheet, opened from the URL", () => {
	it("opens on the cloud that was clicked, and names it in the URL", async () => {
		renderHost();
		await openGcp();
		expect(testParam("wizard")).toBe("cloud-connect");
		expect(testParam("step")).toBe("gcp");
		expect(screen.getByText("Connect GCP Project")).toBeInTheDocument();
		expect(h.start).not.toHaveBeenCalled();
	});

	it("does not open for a cloud this release does not offer", () => {
		renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open alibaba" }));
		expect(testParam("wizard")).toBeNull();
	});

	it("says so when a link names a cloud that is not offered", async () => {
		setTestSearch("wizard=cloud-connect&step=alibaba");
		renderHost();
		expect(await screen.findByText("Alibaba Cloud is not available in this release.")).toBeInTheDocument();
		expect(screen.queryByLabelText("RAM Role ARN")).toBeNull();
	});

	it("opens a re-enabled cloud once the server offers it", async () => {
		h.offered.clouds = ["aws", "gcp", "azure", "alibaba", "hetzner"];
		setTestSearch("wizard=cloud-connect&step=alibaba");
		renderHost();
		expect(await screen.findByLabelText("RAM Role ARN")).toBeInTheDocument();
	});
});

describe("GCP is a form with a message per field (B-04)", () => {
	it("an empty Connect names both fields and sends nothing", async () => {
		renderHost();
		await openGcp();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(await screen.findByText("Enter the project ID.")).toBeInTheDocument();
		expect(screen.getByText("Enter the project number the script printed.")).toBeInTheDocument();
		expect(h.start).not.toHaveBeenCalled();
		expect(h.connect).not.toHaveBeenCalled();
	});

	it("writes the typed project ID into the command to copy", async () => {
		renderHost();
		const projectId = await openGcp();
		expect(screen.getByText(/alethia-gcp-setup\.sh YOUR_PROJECT_ID/)).toBeInTheDocument();
		fireEvent.change(projectId, { target: { value: "acme-prod-1" } });
		expect(await screen.findByText(/alethia-gcp-setup\.sh acme-prod-1/)).toBeInTheDocument();
	});

	it("fills both ids from the script's pasted output", async () => {
		renderHost();
		await openGcp();
		fireEvent.paste(screen.getByLabelText("Project number"), {
			clipboardData: { getData: () => "  Project ID:      acme-prod-1\n  Project Number:  123456789012\n" },
		});
		await waitFor(() => expect(screen.getByLabelText("Project ID")).toHaveValue("acme-prod-1"));
		expect(screen.getByLabelText("Project number")).toHaveValue("123456789012");
	});

	it("says which setup method is chosen in words, not only by its fill (B-05)", async () => {
		renderHost();
		await openGcp();
		expect(screen.getByRole("button", { name: /gcloud CLI/ })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: /Terraform/ })).toHaveAttribute("aria-pressed", "false");
	});
});

describe("Connect ends on an outcome with Done (B-03)", () => {
	it("starts the session on the press, verifies, hands back the account and offers Done", async () => {
		const { onConnected } = renderHost();
		await openGcp();
		typeGcpIds();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));

		const outcome = await screen.findByText("Connection verified");
		expect(outcome.closest('[role="status"]')).not.toBeNull();
		expect(h.start).toHaveBeenCalledWith({ provider: "gcp" });
		expect(h.connect).toHaveBeenCalledWith({
			method: "gcp-ids",
			identityId: STARTED,
			projectId: "acme-prod-1",
			projectNumber: "123456789012",
		});
		expect(onConnected).toHaveBeenCalledWith({ identityId: STARTED, provider: "gcp" });

		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() => expect(testParam("wizard")).toBeNull());
		expect(testParam("step")).toBeNull();
	});

	it("saves into the host's seeded identity without starting another", async () => {
		renderHost({ gcpSetup: { identityId: SEEDED } });
		h.connect.mockResolvedValue(verified(SEEDED));
		await openGcp();
		typeGcpIds();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));

		await screen.findByText("Connection verified");
		expect(h.start).not.toHaveBeenCalled();
		expect(h.connect.mock.calls[0]?.[0]).toMatchObject({ identityId: SEEDED });
	});

	it("puts a server field refusal under its field, not in the callout", async () => {
		h.connect.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Check the values.", fields: { projectNumber: ["Project number must be digits only."] } },
		});
		renderHost();
		await openGcp();
		typeGcpIds();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("Project number must be digits only.")).toBeInTheDocument();
		expect(screen.queryByText("Verification failed")).toBeNull();
	});

	it("a failed verify is an alert with Retry, and the retry saves into the same identity", async () => {
		h.connect.mockResolvedValue(verified(STARTED, false));
		const { onConnected } = renderHost();
		await openGcp();
		typeGcpIds();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));

		const failure = await screen.findByText("The pool does not trust this issuer.");
		expect(failure.closest('[role="alert"]')).not.toBeNull();
		expect(onConnected).not.toHaveBeenCalled();

		h.connect.mockResolvedValue(verified(STARTED));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText("Connection verified");
		expect(h.start).toHaveBeenCalledTimes(1);
		expect(h.connect).toHaveBeenCalledTimes(2);
	});
});

describe("what survives a reload", () => {
	it("the sheet, its cloud and the typed ids come back, with a way to start over", async () => {
		const first = renderHost();
		await openGcp();
		typeGcpIds();
		first.unmount();

		renderHost();
		await waitFor(() => expect(screen.getByLabelText("Project ID")).toHaveValue("acme-prod-1"));
		expect(screen.getByLabelText("Project number")).toHaveValue("123456789012");
		expect(screen.getByText(/Restored your draft/)).toBeInTheDocument();
	});

	it("a Hetzner token never reaches storage", async () => {
		const token = "hcloud-token-that-must-not-be-stored-0123456789";
		const first = renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open hetzner" }));
		fireEvent.change(await screen.findByLabelText("API Token"), { target: { value: token } });
		first.unmount();

		const stored: string[] = [];
		for (let i = 0; i < sessionStorage.length; i++) {
			const key = sessionStorage.key(i);
			if (key !== null) stored.push(`${key}=${sessionStorage.getItem(key) ?? ""}`);
		}
		expect(stored.filter((entry) => entry.includes(token))).toEqual([]);
	});
});

describe("keyless readiness (EDN-H6)", () => {
	it.each([
		["signing-key-missing", /no issuer signing key/],
		["origin-missing", /no public URL configured/],
		["origin-not-https", /not HTTPS/],
		["origin-not-public", /private or local address/],
	])("%s: AWS, GCP and Azure show the not-reachable state instead of a form", async (reason, text) => {
		h.keyless.readiness = { ready: false, reason };
		renderHost();
		for (const slug of ["aws", "gcp", "azure"]) {
			fireEvent.click(screen.getByRole("button", { name: `Open ${slug}` }));
			expect(await screen.findByText("This instance is not publicly reachable")).toBeInTheDocument();
			expect(screen.getByText(text)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
			fireEvent.click(within(screen.getByTestId("keyless-not-reachable")).getByRole("button", { name: "Close" }));
			await waitFor(() => expect(testParam("wizard")).toBeNull());
		}
		expect(h.start).not.toHaveBeenCalled();
		expect(h.connect).not.toHaveBeenCalled();
	});

	it("Hetzner is unaffected: its form opens on the same instance", async () => {
		h.keyless.readiness = { ready: false, reason: "origin-not-public" };
		renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open hetzner" }));
		expect(await screen.findByLabelText("API Token")).toBeInTheDocument();
		expect(screen.queryByText("This instance is not publicly reachable")).toBeNull();
	});

	it("offers Hetzner instead, and opens its form", async () => {
		h.keyless.readiness = { ready: false, reason: "signing-key-missing" };
		renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open aws" }));
		fireEvent.click(await screen.findByRole("button", { name: "Connect Hetzner instead" }));
		expect(await screen.findByLabelText("API Token")).toBeInTheDocument();
		expect(testParam("step")).toBe("hetzner");
	});

	it("does not offer Hetzner when this deployment does not", async () => {
		h.offered.clouds = ["aws", "gcp", "azure"];
		h.keyless.readiness = { ready: false, reason: "origin-not-https" };
		renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open aws" }));
		await screen.findByText("This instance is not publicly reachable");
		expect(screen.queryByRole("button", { name: "Connect Hetzner instead" })).toBeNull();
	});

	it("a ready instance shows the AWS form", async () => {
		renderHost();
		fireEvent.click(screen.getByRole("button", { name: "Open aws" }));
		expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
		expect(screen.queryByText("This instance is not publicly reachable")).toBeNull();
	});
});
