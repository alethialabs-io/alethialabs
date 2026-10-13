// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Runners page when the workspace load FAILED (#5895).
//
// Runners waits on `useEntitlement("byoRunners")`: `null` (unknown) shows the runner skeleton,
// because neither the page nor the upsell may render before the store has answered (#5864). A
// failed load used to leave the store in the never-fetched shape, so the skeleton stayed for good —
// no error, no retry. The page now says the workspace could not be loaded and offers Retry, which
// re-runs `fetchWorkspace()`; and it still renders neither the runners nor the upsell. Real hook,
// real store; the server action and the page's data hooks are mocked.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "@/app/server/actions/workspace";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(""),
}));

const { getWorkspaceContext } = vi.hoisted(() => ({
	getWorkspaceContext: vi.fn<() => Promise<WorkspaceContext>>(),
}));
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext,
	setActiveOrganization: vi.fn(),
}));

vi.mock("@/lib/query/use-jobs-query", () => ({ useJobsQuery: () => ({ data: [] }) }));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ data: undefined, isSuccess: false }),
	useSetPoolEnabled: () => ({ mutateAsync: vi.fn() }),
	useDeletePool: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/query/use-runners-page-query", () => ({
	useRunnersPageQuery: () => ({
		data: { rows: [], total: 0, facets: { clouds: [], regions: [], versions: [] } },
		isPending: false,
		isError: false,
		isPlaceholderData: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => true }));
vi.mock("@/components/runners/add-runner-button", () => ({ AddRunnerButton: () => null }));
vi.mock("@/components/runners/fleet-pool-wizard", () => ({ FleetPoolWizard: () => null }));
vi.mock("@/components/runners/versions-panel", () => ({ VersionsPanel: () => null }));
vi.mock("@/components/runners/runners-toolbar", () => ({ RunnersToolbar: () => null }));
vi.mock("@/components/runners/runners-pager", () => ({ RunnersPager: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: () => <div>BYO runners are a paid feature</div>,
}));

import { RunnersClient } from "@/app/(private)/[org]/~/runners/runners-client";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const ERROR_TITLE = /couldn't load your workspace/i;
const UPSELL = "BYO runners are a paid feature";

/** The workspace context the server answers once the load recovers. */
function context(byoRunners: boolean): WorkspaceContext {
	return {
		activeOrgId: "org-1",
		organizations: [],
		entitlements: { ...COMMUNITY_ENTITLEMENTS, byoRunners },
		isHosted: true,
	};
}

/** Runs the store's real load against a failing server action. */
async function failLoad(): Promise<void> {
	getWorkspaceContext.mockRejectedValueOnce(new Error("network down"));
	await act(() => useWorkspaceStore.getState().fetchWorkspace());
}

beforeEach(() => {
	sessionStorage.clear();
	getWorkspaceContext.mockReset();
	useWorkspaceStore.setState({
		activeOrgId: null,
		organizations: [],
		entitlements: null,
		isHosted: false,
		loadStatus: "idle",
	});
});

describe("Runners when the workspace load failed (#5895)", () => {
	it("shows the skeleton, not an error, before the store has been asked", () => {
		const { container } = render(<RunnersClient />);
		expect(container.querySelector("[aria-busy]")).not.toBeNull();
		expect(screen.queryByText(ERROR_TITLE)).toBeNull();
	});

	it("replaces the skeleton with an error and a Retry button once the load fails", async () => {
		const { container } = render(<RunnersClient />);
		await failLoad();
		expect(screen.getByRole("alert").textContent).toMatch(ERROR_TITLE);
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		expect(container.querySelector("[aria-busy]")).toBeNull();
	});

	it("fails closed: neither the runners page nor the upsell renders on a failed load", async () => {
		render(<RunnersClient />);
		await failLoad();
		expect(screen.queryByText(UPSELL)).toBeNull();
		expect(screen.queryByText("Pools")).toBeNull();
		expect(screen.queryByText(/no runners/i)).toBeNull();
	});

	it("Retry re-runs the workspace load, and a successful one shows the page", async () => {
		render(<RunnersClient />);
		await failLoad();
		getWorkspaceContext.mockResolvedValueOnce(context(true));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(getWorkspaceContext).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(screen.queryByText(ERROR_TITLE)).toBeNull());
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
		expect(screen.queryByText(UPSELL)).toBeNull();
	});
});
