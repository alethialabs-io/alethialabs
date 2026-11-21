// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview toolbar's Create menu (#6817). An entry the viewer cannot use right now is disabled
// WITH its reason, and no entry opens a surface chosen from an answer the console does not have.
//
// The member entry is decided by the plan, on the overview's usage read. It used to default to "may
// not invite" while that read was pending or had failed, so an organization that may invite was
// shown the upgrade dialog.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: h.push, replace: vi.fn(), refresh: vi.fn() }),
}));
// Each dialog is a tree of forms and actions; what matters here is WHICH one the menu opens.
vi.mock("@/components/settings/members/invite-member-dialog", () => ({
	InviteMemberDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="invite-dialog" /> : null),
}));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({
	UpgradeDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="upgrade-dialog" /> : null),
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import type { OverviewState } from "@/components/overview/overview-state";
import {
	INVITE_PENDING_REASON,
	INVITE_UNKNOWN_REASON,
	OverviewToolbar,
} from "@/components/overview/overview-toolbar";
import { never, reads, renderWithReads } from "./rpc-fake";

const PRISTINE: OverviewState = { q: "", clouds: [], repos: [], sort: "activity", view: "card" };

/** Renders the toolbar and opens its Create menu. */
async function openCreateMenu(createProjectReason: string | null = null) {
	const user = userEvent.setup();
	renderWithReads(
		<OverviewToolbar
			orgSlug="acme"
			state={PRISTINE}
			facets={{ clouds: [], repos: [] }}
			createProjectReason={createProjectReason}
			onChange={vi.fn()}
		/>,
	);
	await user.click(screen.getByRole("button", { name: "Create" }));
	return user;
}

/** The menu item whose label starts with `label`. */
function item(label: string): HTMLElement {
	return screen.getByRole("menuitem", { name: new RegExp(`^${label}`) });
}

beforeEach(() => {
	h.push.mockReset();
	reads.usage.mockReset();
	reads.usage.mockImplementation(never);
});

describe("OverviewToolbar — Create menu, the member entry", () => {
	it("while the plan read is pending: disabled with the reason, and neither dialog opens", async () => {
		await openCreateMenu();
		const member = item("Organization member");
		expect(member).toHaveAttribute("aria-disabled", "true");
		expect(member.textContent).toContain(INVITE_PENDING_REASON);
		expect(screen.queryByTestId("upgrade-dialog")).not.toBeInTheDocument();
		expect(screen.queryByTestId("invite-dialog")).not.toBeInTheDocument();
	});

	it("when the plan read failed: disabled with where to retry it, not the upgrade dialog", async () => {
		reads.usage.mockRejectedValue(new Error("boom"));
		await openCreateMenu();
		await waitFor(() => expect(item("Organization member").textContent).toContain(INVITE_UNKNOWN_REASON));
		expect(item("Organization member")).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByTestId("upgrade-dialog")).not.toBeInTheDocument();
	});

	it("an organization that may invite gets the invite dialog", async () => {
		reads.usage.mockResolvedValue({ canInvite: true });
		const user = await openCreateMenu();
		await waitFor(() => expect(item("Organization member")).not.toHaveAttribute("aria-disabled", "true"));
		await user.click(item("Organization member"));
		expect(await screen.findByTestId("invite-dialog")).toBeInTheDocument();
		expect(screen.queryByTestId("upgrade-dialog")).not.toBeInTheDocument();
	});

	it("an organization whose plan cannot invite gets the upgrade dialog, once the read has said so", async () => {
		reads.usage.mockResolvedValue({ canInvite: false });
		const user = await openCreateMenu();
		await waitFor(() => expect(item("Organization member")).not.toHaveAttribute("aria-disabled", "true"));
		await user.click(item("Organization member"));
		expect(await screen.findByTestId("upgrade-dialog")).toBeInTheDocument();
		expect(screen.queryByTestId("invite-dialog")).not.toBeInTheDocument();
	});
});

describe("OverviewToolbar — Create menu, the project and cloud account entries", () => {
	it("a viewer who may create a project is taken to the create flow", async () => {
		const user = await openCreateMenu(null);
		await user.click(screen.getByRole("menuitem", { name: "Project" }));
		expect(h.push).toHaveBeenCalledWith("/acme/~/new");
	});

	it("a viewer who may not is shown the entry disabled with its reason, and goes nowhere", async () => {
		await openCreateMenu(MANAGE_DENIED_REASON);
		const project = item("Project");
		expect(project).toHaveAttribute("aria-disabled", "true");
		expect(project.textContent).toContain(MANAGE_DENIED_REASON);
		expect(h.push).not.toHaveBeenCalled();
	});

	it("the cloud entry is named for what it connects, and opens the cloud connectors", async () => {
		const user = await openCreateMenu();
		await user.click(screen.getByRole("menuitem", { name: "Cloud account" }));
		expect(h.push).toHaveBeenCalledWith("/acme/~/connectors?type=cloud");
	});
});

describe("OverviewToolbar — search and filter controls", () => {
	it("each control has an accessible name", async () => {
		await openCreateMenu();
		expect(screen.getByRole("textbox", { name: "Search projects" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Filter and sort" })).toBeInTheDocument();
	});
});
