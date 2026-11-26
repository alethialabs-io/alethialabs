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
	// The menu mounts its items after the click resolves, so wait for them before any lookup.
	await screen.findAllByRole("menuitem");
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
		expect(screen.getByRole("button", { name: "Sort by Activity" })).toBeInTheDocument();
	});
});

// R6 B-24: the overview's filters are the console filter standard's controls — a Cloud facet, a
// Repository facet and the mono Reset, on the one-row ListToolbar (#7738) — not a bespoke funnel
// popover of its own.
describe("OverviewToolbar — the filter standard (B-24)", () => {
	/** Renders the toolbar with `state` and a small facet universe. */
	function renderToolbar(state: OverviewState, onChange = vi.fn()) {
		renderWithReads(
			<OverviewToolbar
				orgSlug="acme"
				state={state}
				facets={{
					clouds: [{ value: "aws", count: 2 }],
					repos: [{ url: "https://github.com/acme/web", label: "acme/web", count: 1 }],
				}}
				createProjectReason={null}
				onChange={onChange}
			/>,
		);
		return onChange;
	}

	it("draws the facet controls in the bar, with no funnel popover", () => {
		renderToolbar(PRISTINE);
		expect(screen.getByRole("button", { name: "Repository" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cloud" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Filter and sort" })).toBeNull();
	});

	it("a selected facet names its values, and its own × clears just that facet", async () => {
		const onChange = renderToolbar({ ...PRISTINE, clouds: ["aws"], repos: ["https://github.com/acme/web"] });
		expect(screen.getByRole("button", { name: "Cloud: AWS" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Repository: acme/web" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear Cloud" }));
		expect(onChange).toHaveBeenCalledWith({ clouds: [] });
		expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ repos: [] }));
	});

	it("offers each cloud with its count from the unfiltered universe", async () => {
		renderToolbar(PRISTINE);
		await userEvent.click(screen.getByRole("button", { name: "Cloud" }));
		expect(await screen.findByRole("option", { name: "AWS, 2" })).toBeInTheDocument();
	});

	it("draws no description line and no page toolbar — the row starts with the search", () => {
		renderToolbar(PRISTINE);
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		const row = document.querySelector('[data-slot="filter-search"]')?.parentElement;
		expect(row?.firstElementChild?.getAttribute("data-slot")).toBe("filter-search");
		// The view toggle and the two actions sit in the right-aligned group.
		const end = row?.querySelector('[data-slot="list-toolbar-end"]');
		expect(end?.querySelector('button[aria-label="Sort by Activity"]')).not.toBeNull();
		expect(end?.textContent).toContain("Create");
	});

	it("Reset appears with a selection, counts it, and clears the filters but not the sort", async () => {
		const onChange = renderToolbar({ ...PRISTINE, clouds: ["aws"], repos: ["https://github.com/acme/web"], sort: "name" });
		const reset = screen.getByRole("button", { name: "Reset · 2" });
		await userEvent.click(reset);
		expect(onChange).toHaveBeenCalledWith({ q: "", clouds: [], repos: [] });
	});

	it("no Reset while nothing is filtered", () => {
		renderToolbar({ ...PRISTINE, sort: "name" });
		expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
	});

	it("the sort menu sets the order", async () => {
		const onChange = renderToolbar(PRISTINE);
		await userEvent.click(screen.getByRole("button", { name: "Sort by Activity" }));
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Name" }));
		expect(onChange).toHaveBeenCalledWith({ sort: "name" });
	});
});
