// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6128: the save is `savePreviewConfig` through `useActionMutation`; the page reads
// `settings.preview` (prefetched and hydrated), rendered here through `PreviewSettingsPage`.

import { ORPCError } from "@orpc/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PreviewSettings,
	PreviewSettingsPage,
} from "@/components/settings/preview/preview-settings";
import { PreviewSettingsSkeleton } from "@/components/settings/preview/preview-settings-skeleton";
import { orpc } from "@/lib/rpc/client";
import type { PreviewSettingsRead } from "@/lib/rpc/procedures/settings";
import { failRead, seededClient, withQueryClient } from "../support/general-settings";

const { savePreviewConfig } = vi.hoisted(() => ({
	savePreviewConfig: vi.fn(),
}));

vi.mock("@/app/server/actions/preview", () => ({
	savePreviewConfig: (raw: unknown) => savePreviewConfig(raw),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/components/repository-selector", () => ({
	// The skeleton's Source row is the selector's own; a stand-in with the same data-slots.
	RepositorySelectorSkeleton: ({ linked }: { linked: boolean | undefined }) => (
		<div data-slot={linked === false ? "git-accounts-skeleton" : "repository-row-skeleton"} />
	),
	RepositorySelector: ({
		value,
		onChange,
		onRepositorySelect,
	}: {
		value: string;
		onChange: (value: string) => void;
		onRepositorySelect?: (repo: {
			id: string;
			name: string;
			full_name: string;
			url: string;
			private: boolean;
			default_branch: string;
			provider: "github";
		}) => void;
	}) => (
		<div>
			<input
				aria-label="Preview repository"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<button
				type="button"
				onClick={() =>
					onRepositorySelect?.({
						id: "repo-1",
						name: "shop",
						full_name: "acme/shop",
						url: "https://github.com/acme/shop",
						private: true,
						default_branch: "main",
						provider: "github",
					})
				}
			>
				Select repo
			</button>
		</div>
	),
}));

const FABRICS = [
	{ id: "11111111-1111-4111-8111-111111111111", name: "shared", region: "eu-west-1", status: "ACTIVE" },
] as const;
const CREDS = [
	{ id: "22222222-2222-4222-8222-222222222222", purpose: "argocd", method: "oauth" },
	{ id: "33333333-3333-4333-8333-333333333333", purpose: "applications", method: "pat" },
] as const;

function renderPanel(initialConfig = null, fabrics: (typeof FABRICS)[number][] = [...FABRICS]) {
	return render(
		withQueryClient(
			<PreviewSettings
				projectId="proj-1"
				initialConfig={initialConfig}
				fabrics={fabrics}
				gitCredentials={[...CREDS]}
				gitlabBaseUrl="https://gitlab.com"
				providerAvailability={{ github: true, gitlab: true, bitbucket: true }}
			/>,
		),
	);
}

/** The page body over a client holding (or failing) the `settings.preview` read. */
function renderPage(client = seededClient()) {
	return render(
		withQueryClient(
			<PreviewSettingsPage
				project="shop"
				gitlabBaseUrl="https://gitlab.com"
				providerAvailability={{ github: true, gitlab: true, bitbucket: true }}
			/>,
			client,
		),
	);
}

const PREVIEW_KEY = orpc.settings.preview.queryKey({ input: { project: "shop" } });
const LINKED_KEY = orpc.projects.linkedGitProviders.queryKey();

/** A client holding the viewer's linked git providers, as the route's prefetch leaves it. */
function linkedClient(): ReturnType<typeof seededClient> {
	const client = seededClient();
	client.setQueryData(LINKED_KEY, []);
	return client;
}

/** The text of each settings row's label column, top to bottom. */
function rowLabels(root: HTMLElement): string[] {
	return Array.from(root.querySelectorAll(".grid-cols-\\[200px_1fr\\] > div:first-child")).map(
		(el) => el.textContent ?? "",
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	savePreviewConfig.mockResolvedValue({
		ok: true,
		data: {
			config: {
				enabled: true,
				git_provider: "github",
				repo_owner: "acme",
				repo_name: "shop",
				apps_path: ".",
				placement_mode: "namespace",
				namespace_prefix: "preview",
				fabric_id: null,
				git_credential_id: null,
			},
		},
	});
});

describe("PreviewSettings", () => {
	it("blocks saving a blank configuration with schema validation", async () => {
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("switch", { name: /enable preview/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		expect(await screen.findByText(/too small/i)).toBeInTheDocument();
		expect(savePreviewConfig).not.toHaveBeenCalled();
	});

	it("saves selected repository parts and enabled state through the form action", async () => {
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Select repo" }));
		await user.click(screen.getByRole("switch", { name: /enable preview/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(savePreviewConfig).toHaveBeenCalledTimes(1));
		expect(savePreviewConfig).toHaveBeenCalledWith({
			projectId: "proj-1",
			config: expect.objectContaining({
				enabled: true,
				git_provider: "github",
				repo_owner: "acme",
				repo_name: "shop",
			}),
		});
		expect(toast.success).toHaveBeenCalledWith("Preview settings saved.");
	});

	it("#6128: puts a server field error under its field, not in a toast", async () => {
		savePreviewConfig.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "must be a DNS-1123 label",
				fields: { "config.namespace_prefix": ["must be a DNS-1123 label"] },
			},
		});
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Select repo" }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(await screen.findByText("must be a DNS-1123 label")).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("#6128: sends one save for three rapid clicks", async () => {
		let finish: (value: unknown) => void = () => {};
		savePreviewConfig.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Select repo" }));
		const save = screen.getByRole("button", { name: /save changes/i });
		await user.click(save);
		await user.click(save);
		await user.click(save);
		await waitFor(() => expect(savePreviewConfig).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
		finish({ ok: false, error: { kind: "unexpected", ref: "deadbeef" } });
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(savePreviewConfig).toHaveBeenCalledTimes(1);
	});
});

describe("PreviewSettingsPage — four renders (#6128)", () => {
	it("paints the hydrated read as the form, with no fetch", () => {
		const client = linkedClient();
		const read: PreviewSettingsRead = {
			projectId: "proj-1",
			config: null,
			fabrics: [...FABRICS],
			gitCredentials: [...CREDS],
		};
		client.setQueryData(PREVIEW_KEY, read);
		renderPage(client);
		expect(screen.getByRole("switch", { name: /enable preview/i })).toBeInTheDocument();
	});

	it("renders a refusal, a failure, a gone project and pending each as itself", () => {
		const refused = linkedClient();
		failRead(refused, PREVIEW_KEY, new ORPCError("FORBIDDEN", { defined: true }));
		const a = renderPage(refused);
		expect(a.container.querySelector('[data-state="refused"]')).not.toBeNull();
		a.unmount();

		const failed = linkedClient();
		failRead(failed, PREVIEW_KEY, new Error("network"));
		const b = renderPage(failed);
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		b.unmount();

		const gone = linkedClient();
		gone.setQueryData(PREVIEW_KEY, null);
		const c = renderPage(gone);
		expect(screen.getByText("This project is gone")).toBeInTheDocument();
		c.unmount();

		const d = renderPage(linkedClient());
		expect(d.container.querySelector('[data-slot="preview-settings-skeleton"]')).not.toBeNull();
	});
});

describe("Preview settings — the skeleton has the form's shape (#6335, RUBRIC B2)", () => {
	it("draws the form's rows, with the form's labels and hints, in the form's order", () => {
		const form = renderPanel();
		const formRows = rowLabels(form.container);
		form.unmount();
		const skeleton = render(withQueryClient(<PreviewSettingsSkeleton linked={false} />));
		expect(formRows).toHaveLength(4);
		// The hint wraps in a 200px column, so the row's height is the copy's: the same words.
		expect(rowLabels(skeleton.container)).toEqual(formRows);
	});

	it("keeps the Placement note whatever the project's fabrics, so that row has one height", () => {
		const some = renderPanel(null, [...FABRICS]);
		expect(screen.getByText(/keep Default fabric/)).toBeInTheDocument();
		some.unmount();
		renderPanel(null, []);
		expect(screen.getByText(/No project fabrics found/)).toBeInTheDocument();
	});
});
