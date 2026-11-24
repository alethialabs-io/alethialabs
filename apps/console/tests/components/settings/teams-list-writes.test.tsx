// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams, CON-L10. Drives the REAL `TeamsList`; only the network edges are mocked.
//
//   · E-08 — what the viewer may write is the route's `gate`: without it Create team, Rename team
//     and Delete team are disabled WITH a reason, never live controls that end in a toast;
//   · E-14 — a team can be renamed (Better Auth's `updateTeam`), and no slug is invented for it;
//   · E-15 — the cells are stable: an open row menu survives the list answering again.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsPage } from "@/lib/queries/teams";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/teams",
	useSearchParams: () => new URLSearchParams(""),
}));

const h = vi.hoisted(() => ({
	getTeamsPage: vi.fn<(query: unknown) => Promise<TeamsPage>>(),
	updateTeam: vi.fn(async (_input: unknown) => ({ error: null })),
	removeTeam: vi.fn(async (_input: unknown) => ({ error: null })),
	createTeam: vi.fn(async (_input: unknown) => ({ error: null })),
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({ "members.teams": async (input) => h.getTeamsPage(input) }).orpc };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			updateTeam: (input: unknown) => h.updateTeam(input),
			removeTeam: (input: unknown) => h.removeTeam(input),
			createTeam: (input: unknown) => h.createTeam(input),
		},
	},
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({ FeatureUpsell: () => null }));
vi.mock("@/components/settings/teams/manage-team-dialog", () => ({ ManageTeamDialog: () => null }));

import type { TeamsGate } from "@/components/settings/teams/teams-gate";
import { TEAM_WRITE_DENIED, TeamsList } from "@/components/settings/teams/teams-list";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";

const PAGE: TeamsPage = {
	rows: [{ id: "t1", name: "Networking", memberCount: 0, members: [] }],
	resultCount: 1,
	total: 1,
	facets: { sizes: [] },
};

const ALL: TeamsGate = { canCreate: true, canRename: true, canDelete: true, canEditRoster: true };
const NONE: TeamsGate = { canCreate: false, canRename: false, canDelete: false, canEditRoster: true };

/** The list, entitled, with `gate`, inside a fresh query provider. */
function tree(gate: TeamsGate, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })): ReactNode {
	return (
		<QueryClientProvider client={client}>
			<TeamsList entitled gate={gate} />
		</QueryClientProvider>
	);
}

/** The text of every element `el`'s `aria-describedby` names. */
function description(el: HTMLElement): string {
	return (el.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ");
}

beforeEach(() => {
	sessionStorage.clear();
	useTeamsFilters.getState().reset();
	h.getTeamsPage.mockReset();
	h.getTeamsPage.mockResolvedValue(PAGE);
	h.updateTeam.mockClear();
	h.removeTeam.mockClear();
	h.createTeam.mockClear();
});

describe("the role gate (R6 E-08)", () => {
	it("disables Create team with the reason when the role may not create", async () => {
		render(tree(NONE));
		await waitFor(() => expect(screen.getByText("Networking")).toBeTruthy());
		const create = screen.getByRole("button", { name: /create team/i });
		expect(create).toBeDisabled();
		expect(description(create)).toContain(TEAM_WRITE_DENIED);
	});

	it("disables Rename in the row menu, saying why, and leaves the roster readable", async () => {
		const user = userEvent.setup();
		render(tree(NONE));
		await user.click(await screen.findByRole("button", { name: "Manage team Networking" }));
		const rename = await screen.findByRole("menuitem", { name: /Rename team/ });
		expect(rename).toHaveAttribute("aria-disabled", "true");
		expect(rename).toHaveTextContent(TEAM_WRITE_DENIED);
		// Delete stays reachable on the plan alone until #7050 names the roles (see teams-list.tsx):
		// its confirmation is a measured registry entry, and the server's refusal shows in it.
		expect(screen.getByRole("menuitem", { name: "Delete team" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
		expect(screen.getByRole("menuitem", { name: "Manage members" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
	});
});

describe("rename (R6 E-14)", () => {
	it("shows no derived slug under the name", async () => {
		render(tree(ALL));
		await waitFor(() => expect(screen.getByText("Networking")).toBeTruthy());
		expect(screen.queryByText("networking")).toBeNull();
	});

	it("renames through updateTeam and closes once it has succeeded", async () => {
		const user = userEvent.setup();
		render(tree(ALL));
		await user.click(await screen.findByRole("button", { name: "Manage team Networking" }));
		await user.click(await screen.findByRole("menuitem", { name: "Rename team" }));
		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getByRole("textbox", { name: "Team name" });
		expect(field).toHaveValue("Networking");
		await user.clear(field);
		await user.type(field, "Platform");
		await user.click(within(dialog).getByRole("button", { name: "Save name" }));
		await waitFor(() => expect(h.updateTeam).toHaveBeenCalledTimes(1));
		expect(h.updateTeam).toHaveBeenCalledWith({ teamId: "t1", data: { name: "Platform" } });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("refuses an empty name under the field, without a request", async () => {
		const user = userEvent.setup();
		render(tree(ALL));
		await user.click(await screen.findByRole("button", { name: "Manage team Networking" }));
		await user.click(await screen.findByRole("menuitem", { name: "Rename team" }));
		const dialog = await screen.findByRole("dialog");
		await user.clear(within(dialog).getByRole("textbox", { name: "Team name" }));
		await user.click(within(dialog).getByRole("button", { name: "Save name" }));
		expect(await within(dialog).findByRole("alert")).toHaveTextContent("Name the team");
		expect(h.updateTeam).not.toHaveBeenCalled();
	});
});

describe("delete", () => {
	it("asks first, naming the team, and deletes once on confirm", async () => {
		const user = userEvent.setup();
		render(tree(ALL));
		await user.click(await screen.findByRole("button", { name: "Manage team Networking" }));
		await user.click(await screen.findByRole("menuitem", { name: "Delete team" }));
		const dialog = await screen.findByRole("alertdialog");
		// R6 E-21: the question names the team it deletes.
		expect(dialog).toHaveTextContent("Delete team \u201CNetworking\u201D?");
		expect(h.removeTeam).not.toHaveBeenCalled();
		await user.click(within(dialog).getByRole("button", { name: "Delete team" }));
		await waitFor(() => expect(h.removeTeam).toHaveBeenCalledWith({ teamId: "t1" }));
		expect(h.removeTeam).toHaveBeenCalledTimes(1);
	});
});

describe("stable cells (R6 E-15)", () => {
	it("keeps an open row menu open when the list answers again", async () => {
		const user = userEvent.setup();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { rerender } = render(tree(ALL, client));
		await user.click(await screen.findByRole("button", { name: "Manage team Networking" }));
		const item = await screen.findByRole("menuitem", { name: "Rename team" });

		// The refetch: an equal payload whose every object is new, written into the cache the list
		// reads, then a re-render of the whole tree.
		const fresh: TeamsPage = { ...PAGE, rows: PAGE.rows.map((r) => ({ ...r, members: [] })) };
		h.getTeamsPage.mockResolvedValue(fresh);
		await client.invalidateQueries();
		rerender(tree(ALL, client));

		await waitFor(() => expect(h.getTeamsPage.mock.calls.length).toBeGreaterThan(1));
		expect(screen.queryByRole("menuitem", { name: "Rename team" })).toBe(item);
	});
});

// CON-PB2, R6 E-20: Create team was an inline panel, the one create in Settings that was not a
// dialog. A one-field form now opens the same dialog shape as Rename team.
describe("create (R6 E-20)", () => {
	it("opens a dialog, validates the name, creates and closes", async () => {
		const user = userEvent.setup();
		render(tree(ALL));
		await waitFor(() => expect(screen.getByText("Networking")).toBeTruthy());
		await user.click(screen.getAllByRole("button", { name: /create team/i })[0]);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByRole("heading", { name: "Create team" })).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Create team" }));
		expect(await within(dialog).findByRole("alert")).toHaveTextContent("Name the team");
		await user.type(within(dialog).getByRole("textbox", { name: "Team name" }), "Platform");
		await user.click(within(dialog).getByRole("button", { name: "Create team" }));
		await waitFor(() => expect(h.createTeam).toHaveBeenCalledWith({ name: "Platform" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
