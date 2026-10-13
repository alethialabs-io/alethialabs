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

vi.mock("@/app/server/actions/teams", () => ({ getTeamsPage }));
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({
	UpgradeDialog: () => <div>Upgrade to create teams</div>,
}));
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
const UPGRADE = "Upgrade to create teams";

/** An org with no teams yet — the page where the upsell would stand in for the empty state. */
const EMPTY: TeamsPage = { rows: [], resultCount: 0, total: 0, facets: { sizes: [] } };

/** The list inside a fresh query provider. */
function tree(): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<TeamsList />
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

describe("Settings · Teams before the workspace store has loaded (#5864)", () => {
	it("shows an org neither the upsell nor a create action while its entitlement is unknown", async () => {
		render(tree());
		await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());
		expect(screen.queryByText(UPSELL)).toBeNull();
		expect(screen.queryByText(UPGRADE)).toBeNull();
		expect(screen.queryByRole("button", { name: /create team/i })).toBeNull();
	});

	it("gives an entitled org the create action, and never the upsell, once the store answers", async () => {
		render(tree());
		await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());
		loadWorkspace(true);
		expect(screen.getByRole("button", { name: /create team/i })).toBeTruthy();
		expect(screen.queryByText(UPSELL)).toBeNull();
		expect(screen.queryByText(UPGRADE)).toBeNull();
	});

	it("still shows the upsell to an org the store says is not entitled", async () => {
		render(tree());
		await waitFor(() => expect(getTeamsPage).toHaveBeenCalled());
		loadWorkspace(false);
		await waitFor(() => expect(screen.getByText(UPSELL)).toBeTruthy());
		expect(screen.getByText(UPGRADE)).toBeTruthy();
	});
});
