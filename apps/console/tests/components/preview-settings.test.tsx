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
import { MANAGE_DENIED_REASON, MANAGE_PENDING_REASON } from "@/components/errors/manage-gate";
import { FABRIC } from "@/lib/copy/vocabulary";
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

function renderPanel(
	initialConfig = null,
	fabrics: (typeof FABRICS)[number][] = [...FABRICS],
	// `null` stands for "no answer yet": an `undefined` argument would take this default instead.
	canManage: boolean | null = true,
) {
	return render(
		withQueryClient(
			<PreviewSettings
				projectId="proj-1"
				canManage={canManage ?? undefined}
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

/**
 * The text of each settings row's label column, top to bottom — found by the row's `data-slot`,
 * not its column template, which sits behind a container step (`@lg:`) since #6135.
 */
function rowLabels(root: HTMLElement): string[] {
	return Array.from(
		root.querySelectorAll('[data-slot="settings-field"] > [data-slot="settings-field-label"]'),
	).map((el) => el.textContent ?? "");
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

	it("refuses a non-https repository URL, saying which hosts an https:// URL may use", async () => {
		const user = userEvent.setup();
		renderPanel();
		await user.type(screen.getByLabelText("Preview repository"), "http://github.com/acme/shop");
		expect(
			await screen.findByText(
				"Use an https:// URL on github.com, bitbucket.org or gitlab.com, naming the owner and repo (owner/repo).",
			),
		).toBeInTheDocument();
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
			canManage: true,
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
		// The hint's wrap (in the 200px column, or the full panel width when stacked) sets the row's
		// height, so the skeleton carries the copy's own words.
		expect(rowLabels(skeleton.container)).toEqual(formRows);
	});

	it("keeps the Placement note whatever the project's Fabrics, so that row has one height", () => {
		const some = renderPanel(null, [...FABRICS]);
		expect(screen.getByText(/keep Project default/)).toBeInTheDocument();
		some.unmount();
		renderPanel(null, []);
		expect(screen.getByText(/This project has no Fabric yet/)).toBeInTheDocument();
	});
});

// R6 F-32: "Fabric" is the console's word (lib/copy/vocabulary.ts), never printed bare in lower case,
// and its definition is on the page beside it.
describe("Preview settings — the Fabric vocabulary", () => {
	it("prints no lower-case 'fabric', and carries the definition", () => {
		const { container } = renderPanel(null, []);
		const text = container.textContent ?? "";
		expect(text.match(/\bfabrics?\b/g) ?? []).toEqual([]);
		expect(text).toContain(FABRIC.definition.slice(1));
		expect(screen.getByRole("combobox", { name: "Placement Fabric" })).toBeInTheDocument();
	});
});

// R6 F-11: the read says whether the viewer may save. One who may not sees the form read-only and
// Save disabled with the reason; nothing is sent.
describe("Preview settings — what the viewer may change", () => {
	/** The text of every element the control's `aria-describedby` names. */
	function reasonsOf(el: HTMLElement): string {
		return (el.getAttribute("aria-describedby") ?? "")
			.split(/\s+/)
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join(" ");
	}

	it("a viewer who may not save: every control is read-only and Save says why", () => {
		renderPanel(null, [...FABRICS], false);
		expect(screen.getByRole("switch", { name: /enable preview/i })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("textbox", { name: "Apps path" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "Placement mode" })).toBeDisabled();
		const save = screen.getByRole("button", { name: /save changes/i });
		expect(save).toBeDisabled();
		expect(reasonsOf(save)).toContain(MANAGE_DENIED_REASON);
	});

	it("no answer yet: read-only, with the checking reason rather than a refusal", () => {
		renderPanel(null, [...FABRICS], null);
		expect(reasonsOf(screen.getByRole("button", { name: /save changes/i }))).toContain(MANAGE_PENDING_REASON);
	});

	it("puts a field error under its control, announced and described", async () => {
		savePreviewConfig.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Use a relative path",
				fields: { "config.apps_path": ["Use a relative path"] },
			},
		});
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Select repo" }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Use a relative path");
		const input = screen.getByRole("textbox", { name: "Apps path" });
		expect(input).toHaveAttribute("aria-describedby", alert.id);
		expect(input).toHaveAttribute("aria-invalid", "true");
	});
});

// CON-PB2, R6 F-16: nine fields of edits were dropped by a reload or a closed tab without a word.
describe("Preview settings — unsaved edits", () => {
	it("an edit says it is unsaved and asks before the tab goes; a pristine form does neither", async () => {
		const user = userEvent.setup();
		renderPanel();
		expect(screen.queryByText("You have unsaved changes")).toBeNull();
		const pristine = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(pristine);
		expect(pristine.defaultPrevented).toBe(false);

		const appsPath = screen.getByRole("textbox", { name: "Apps path" });
		await user.clear(appsPath);
		await user.type(appsPath, "apps");
		expect(await screen.findByText("You have unsaved changes")).toBeInTheDocument();
		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(true);
	});
});
