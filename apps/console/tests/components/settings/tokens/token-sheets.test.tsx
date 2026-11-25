// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The token sheets (AGT-L2 design §4): Create (with the picker, its "No Deploy permission" and
// "No org:manage_agents" states, validation, and what is actually sent), the shown-once token, and
// Edit environments (read-only facts, save, and the read-only sheet without the permission). The
// sheets are modal dialogs named by their titles.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CI_DEPLOY, ENVIRONMENTS } from "./token-test-kit";

const actions = vi.hoisted(() => ({
	createConsoleServiceToken: vi.fn(),
	updateServiceTokenAutoApprove: vi.fn(),
	revokeConsoleServiceToken: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/server/actions/agents/service-tokens", () => actions);
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	const kit = await import("./token-test-kit");
	return { orpc: fakeOrpc({ "agents.tokenEnvironments": async () => kit.ENVIRONMENTS }).orpc };
});

import { CreateTokenSheet } from "@/components/settings/tokens/create-token-sheet";
import { EditTokenSheet } from "@/components/settings/tokens/edit-token-sheet";
import { pipelineLine, TokenCreatedDialog } from "@/components/settings/tokens/token-created-dialog";

const WEB = ENVIRONMENTS[1];
const WEB_STAGING = "bbbbbbbb-0000-4000-8000-0000000000b4";

/** Wraps `ui` in a fresh query client. */
function withClient(ui: React.ReactNode) {
	return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
}

/** The create sheet, open. */
function renderCreate(canManageAgents = true, onCreated = vi.fn()) {
	render(withClient(<CreateTokenSheet open onOpenChange={vi.fn()} canManageAgents={canManageAgents} onCreated={onCreated} />));
	return { onCreated, sheet: screen.getByRole("dialog", { name: "Create a service token" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Create a service token", () => {
	it("is a modal dialog named by its title, starting as a read/plan/deploy token on every project", async () => {
		const { sheet } = renderCreate();
		expect(sheet).toHaveTextContent("You'll see the token once, right after you create it.");
		expect(within(sheet).getByRole("checkbox", { name: "Read" })).toHaveAttribute("aria-checked", "true");
		expect(within(sheet).getByRole("checkbox", { name: "Deploy" })).toHaveAttribute("aria-checked", "true");
		expect(within(sheet).getByRole("checkbox", { name: "Destroy" })).toHaveAttribute("aria-checked", "false");
		expect(within(sheet).getByRole("radio", { name: /All projects/ })).toBeChecked();
		// Every project's environments are offered, production disabled.
		expect(await within(sheet).findByRole("checkbox", { name: "staging payments-api" })).not.toHaveAttribute(
			"aria-disabled",
		);
		expect(within(sheet).getByRole("checkbox", { name: "production web" })).toHaveAttribute("aria-disabled", "true");
	});

	it("refuses a nameless token beside the field, and sends nothing", async () => {
		const { sheet } = renderCreate();
		await userEvent.setup().click(within(sheet.ownerDocument.body).getByRole("button", { name: "Create token" }));
		expect(await screen.findByText("A token needs a name.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
		expect(actions.createConsoleServiceToken).not.toHaveBeenCalled();
	});

	it("No Deploy permission: unticking Deploy disables the picker and clears its choice", async () => {
		const user = userEvent.setup();
		const { sheet } = renderCreate();
		await user.click(await within(sheet).findByRole("checkbox", { name: "staging web" }));
		await user.click(within(sheet).getByRole("checkbox", { name: "Deploy" }));
		expect(within(sheet).getByText("Needs the Deploy permission")).toBeInTheDocument();
		const staging = within(sheet).getByRole("checkbox", { name: "staging web" });
		expect(staging).toHaveAttribute("aria-disabled", "true");
		expect(staging).toHaveAttribute("aria-checked", "false");
	});

	it("No org:manage_agents: the picker is read-only and the token is created without environments", async () => {
		actions.createConsoleServiceToken.mockResolvedValue({
			ok: true,
			data: { id: "t1", name: "nightly", tokenPrefix: "alethia_sat_x", token: "alethia_sat_secret", scopes: [], projectIds: null, autoApproveEnvironmentIds: [], expiresAt: null },
		});
		const user = userEvent.setup();
		const { sheet } = renderCreate(false);
		expect(within(sheet).getByText("You can't choose these environments")).toBeInTheDocument();
		expect(await within(sheet).findByRole("checkbox", { name: "staging web" })).toHaveAttribute("aria-disabled", "true");
		await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "nightly");
		await user.click(screen.getByRole("button", { name: "Create token" }));
		await waitFor(() => expect(actions.createConsoleServiceToken).toHaveBeenCalledOnce());
		expect(actions.createConsoleServiceToken.mock.calls[0]?.[0]).toMatchObject({ autoApproveEnvironmentIds: [] });
	});

	it("sends what the picker produced: the chosen projects, and only their non-production environments", async () => {
		const onCreated = vi.fn();
		actions.createConsoleServiceToken.mockResolvedValue({
			ok: true,
			data: {
				id: "t2",
				name: "ci-deploy",
				tokenPrefix: "alethia_sat_3f9aK2xQ",
				token: "alethia_sat_3f9aK2xQrest",
				scopes: ["read", "plan", "apply"],
				projectIds: [WEB?.projectId],
				autoApproveEnvironmentIds: [WEB_STAGING],
				expiresAt: null,
			},
		});
		const user = userEvent.setup();
		const { sheet } = renderCreate(true, onCreated);
		await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "ci-deploy");
		await user.click(within(sheet).getByRole("radio", { name: /Only these projects/ }));
		// Nothing chosen yet: the picker asks for a project first.
		expect(within(sheet).getByText("Choose at least one project first.")).toBeInTheDocument();
		await user.click(await within(sheet).findByRole("checkbox", { name: "payments-api" }));
		await user.click(within(sheet).getByRole("checkbox", { name: "web" }));
		await user.click(within(sheet).getByRole("checkbox", { name: "staging payments-api" }));
		await user.click(within(sheet).getByRole("checkbox", { name: "staging web" }));
		// Unticking a project removes its environments from the selection.
		await user.click(within(sheet).getByRole("checkbox", { name: "payments-api" }));
		expect(within(sheet).queryByRole("checkbox", { name: "staging payments-api" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Create token" }));

		await waitFor(() => expect(actions.createConsoleServiceToken).toHaveBeenCalledOnce());
		expect(actions.createConsoleServiceToken.mock.calls[0]?.[0]).toEqual({
			name: "ci-deploy",
			scopes: ["read", "plan", "apply"],
			projectIds: [WEB?.projectId],
			expiresInDays: 90,
			autoApproveEnvironmentIds: [WEB_STAGING],
		});
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(onCreated.mock.calls[0]?.[1]).toEqual([
			{ id: WEB_STAGING, name: "staging", projectId: WEB?.projectId, projectName: "web", stage: "staging" },
		]);
	});

	it("asks for a project when limited to some and none is chosen", async () => {
		const user = userEvent.setup();
		const { sheet } = renderCreate();
		await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "ci");
		await user.click(within(sheet).getByRole("radio", { name: /Only these projects/ }));
		await user.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText("Choose at least one project.")).toBeInTheDocument();
		expect(actions.createConsoleServiceToken).not.toHaveBeenCalled();
	});

	it("shows a refusal from the server in place, and keeps the sheet open", async () => {
		actions.createConsoleServiceToken.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "Production environments always need a person." },
		});
		const user = userEvent.setup();
		const { sheet } = renderCreate();
		await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "ci");
		await user.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText("The token wasn't created")).toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Create a service token" })).toBeInTheDocument();
	});
});

describe("Copy your new token (shown once)", () => {
	const created = {
		id: "t2",
		name: "ci-deploy",
		tokenPrefix: "alethia_sat_3f9aK2xQ",
		token: "alethia_sat_3f9aK2xQrestOfTheSecret",
		scopes: ["read" as const, "plan" as const, "apply" as const],
		projectIds: null,
		autoApproveEnvironmentIds: [WEB_STAGING],
		expiresAt: null,
	};

	it("shows the whole token, a copy button, the pipeline line and what it will do without approval", async () => {
		const onClose = vi.fn();
		render(<TokenCreatedDialog token={created} autoApprove={CI_DEPLOY.autoApproveEnvironments} onClose={onClose} />);
		const dialog = screen.getByRole("dialog", { name: "Copy your new token" });
		expect(dialog).toHaveTextContent("This is the only time it's shown. Alethia stores a fingerprint, never the token.");
		expect(within(dialog).getByLabelText("Service token ci-deploy")).toHaveTextContent(created.token);
		expect(within(dialog).getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
		expect(dialog).toHaveTextContent("ALETHIA_TOKEN=… alethia project deploy --project web --env staging --yes");
		expect(dialog).toHaveTextContent("Deploys to web / staging go ahead without approval.");
		expect(dialog).toHaveTextContent("Everything else this token asks to deploy waits for a person in Approvals.");
		await userEvent.setup().click(within(dialog).getByRole("button", { name: "I've copied it" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("without auto-approve environments, says every deploy waits for a person", () => {
		render(<TokenCreatedDialog token={{ ...created, autoApproveEnvironmentIds: [] }} autoApprove={[]} onClose={vi.fn()} />);
		expect(screen.getByRole("dialog")).toHaveTextContent("Every deploy this token asks for waits for a person in Approvals.");
		expect(pipelineLine([])).toBe("ALETHIA_TOKEN=… alethia project deploy --yes");
	});
});

describe("Edit environments", () => {
	it("shows what cannot change read-only, and saves the new environment list", async () => {
		actions.updateServiceTokenAutoApprove.mockResolvedValue({ ok: true, data: { tokenId: CI_DEPLOY.id, environmentIds: [] } });
		const onOpenChange = vi.fn();
		render(withClient(<EditTokenSheet token={CI_DEPLOY} onOpenChange={onOpenChange} canManageAgents />));
		const sheet = screen.getByRole("dialog", { name: "Edit ci-deploy" });
		expect(sheet).toHaveTextContent("The token itself doesn't change. Pipelines using it keep working.");
		expect(sheet).toHaveTextContent("Read, Plan, Deploy");
		expect(sheet).toHaveTextContent("To change what it can do, create a new token.");
		// Only the token's own project is offered, with its current choice ticked.
		const staging = await within(sheet).findByRole("checkbox", { name: "staging web" });
		expect(staging).toHaveAttribute("aria-checked", "true");
		expect(within(sheet).queryByRole("checkbox", { name: "staging payments-api" })).toBeNull();
		const user = userEvent.setup();
		await user.click(staging);
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() =>
			expect(actions.updateServiceTokenAutoApprove).toHaveBeenCalledWith({ tokenId: CI_DEPLOY.id, environmentIds: [] }),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("without org:manage_agents, is read-only with only Done", async () => {
		render(withClient(<EditTokenSheet token={CI_DEPLOY} onOpenChange={vi.fn()} canManageAgents={false} />));
		const sheet = screen.getByRole("dialog", { name: "Edit ci-deploy" });
		expect(within(sheet).getByText("You can't choose these environments")).toBeInTheDocument();
		expect(await within(sheet).findByRole("checkbox", { name: "staging web" })).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
		expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
	});

	it("closes on Escape", async () => {
		const onOpenChange = vi.fn();
		render(withClient(<EditTokenSheet token={CI_DEPLOY} onOpenChange={onOpenChange} canManageAgents />));
		await screen.findByRole("checkbox", { name: "staging web" });
		await userEvent.setup().keyboard("{Escape}");
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
