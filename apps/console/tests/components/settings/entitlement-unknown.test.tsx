// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An entitlement the client does not know yet is not an entitlement the org lacks (#5864).
//
// `useEntitlement` reads the workspace store, whose `entitlements` is `null` on the server render and
// on every first client paint — `fetchWorkspace()` answers after hydration. It used to read that
// `null` as `false`, so a paying org was shown the upsell (Teams), a disabled Export button
// (Activity) or the BYO-runners upsell in place of the page for as long as that round trip took.
// The hook now answers `null` for "unknown", and a caller renders nothing gated for it: no upsell,
// and no paid action. Drives the real hook and the real workspace store; only the network edges of
// the representative caller are mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsPage } from "@/lib/queries/teams";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/teams",
	useSearchParams: () => new URLSearchParams(""),
}));

const { getTeamsPage } = vi.hoisted(() => ({
	getTeamsPage: vi.fn<(query: unknown) => Promise<TeamsPage>>(),
}));

// The teams page reads over GET since #6129 (`members.teams`).
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({ "members.teams": async (input) => getTeamsPage(input) }).orpc };
});
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: () => <div>Teams are an Enterprise feature</div>,
}));
vi.mock("@/components/settings/teams/manage-team-dialog", () => ({ ManageTeamDialog: () => null }));

import { useEntitlement } from "@/components/settings/enterprise-gate";
import { TeamsList } from "@/components/settings/teams/teams-list";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const UPSELL = "Teams are an Enterprise feature";

/** An org with no teams yet — the page where the upsell would stand in for the empty state. */
const EMPTY: TeamsPage = { rows: [], resultCount: 0, total: 0, facets: { sizes: [] } };

/** One team, as the teams read returns it. */
const TEAM = { id: "t-1", name: "Platform", memberCount: 0, members: [] };

/** The list inside a fresh query provider, with the entitlement the ROUTE resolved on the server. */
function tree(entitled: boolean): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<TeamsList entitled={entitled} />
		</QueryClientProvider>
	);
}

/** Puts the store in the state `fetchWorkspace()` leaves it in once it has answered. */
function loadWorkspace(teams: boolean): void {
	act(() => useWorkspaceStore.setState({ entitlements: { ...COMMUNITY_ENTITLEMENTS, teams } }));
}

beforeEach(() => {
	sessionStorage.clear();
	useTeamsFilters.getState().reset();
	// The store as every first paint finds it: `fetchWorkspace()` has not answered yet.
	useWorkspaceStore.setState({ entitlements: null });
	getTeamsPage.mockReset();
	getTeamsPage.mockResolvedValue(EMPTY);
});

describe("useEntitlement distinguishes unknown from not entitled (#5864)", () => {
	it("answers null while the workspace store has not loaded", () => {
		const { result } = renderHook(() => useEntitlement("teams"));
		expect(result.current).toBeNull();
	});

	it("answers false once the store says the org is not entitled", () => {
		const { result } = renderHook(() => useEntitlement("teams"));
		loadWorkspace(false);
		expect(result.current).toBe(false);
	});

	it("answers true once the store says the org is entitled", () => {
		const { result } = renderHook(() => useEntitlement("teams"));
		loadWorkspace(true);
		expect(result.current).toBe(true);
	});
});

describe("Settings · Teams takes its gate from the server, not the unloaded store (#5864, #6129)", () => {
	const create = () => screen.getByRole("button", { name: /create team/i });

	it("an entitled org gets a live Create team on the first paint, and never the upsell", async () => {
		render(tree(true));
		await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());
		expect(create().hasAttribute("disabled")).toBe(false);
		expect(screen.queryByText(UPSELL)).toBeNull();
	});

	it("an org without teams sees Create team DISABLED with its reason, the upsell as the body, and no filter bar (F017)", async () => {
		render(tree(false));
		await waitFor(() => expect(screen.getByText(UPSELL)).toBeTruthy());
		expect(create().hasAttribute("disabled")).toBe(true);
		const describedBy = create().getAttribute("aria-describedby") ?? "";
		const reason = describedBy
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join(" ");
		expect(reason).toMatch(/Teams are available on the Enterprise plan/);
		// Nothing to filter when the body is the upsell.
		expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
	});

	it("an org that lost the plan still sees its teams, read-only, with the filter bar", async () => {
		getTeamsPage.mockResolvedValue({ rows: [TEAM], resultCount: 1, total: 1, facets: { sizes: [] } });
		render(tree(false));
		await waitFor(() => expect(screen.getByText("Platform")).toBeTruthy());
		expect(screen.getByPlaceholderText("Search teams…")).toBeTruthy();
		expect(screen.queryByText(UPSELL)).toBeNull();
		expect(create().hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Manage team" }).hasAttribute("disabled")).toBe(true);
	});

	it("an in-session upgrade the store reports unlocks Create team", async () => {
		render(tree(false));
		await waitFor(() => expect(screen.getByText(UPSELL)).toBeTruthy());
		loadWorkspace(true);
		await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
	});

	it("a store that says not entitled never locks an org the server entitled", async () => {
		loadWorkspace(false);
		render(tree(true));
		await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());
		expect(create().hasAttribute("disabled")).toBe(false);
	});
});
