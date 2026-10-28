// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org Activity feed's Export button before the workspace store has answered (#5864).
//
// `useEntitlement("activityExport")` is `null` on every first paint. It used to read as `false`, so
// an Enterprise org was first shown a DISABLED Export button titled "requires the Enterprise plan".
// The button is now absent while the entitlement is unknown, enabled once it is known to be held,
// and disabled with the upgrade reason only once it is known not to be. Real hook, real store.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
// The member list is the `members.list` GET read since #6129.
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({ "members.list": async () => [] }).orpc };
});
vi.mock("@/app/server/actions/activity", () => ({
	getActivityLog: vi.fn(async () => ({ rows: [], nextCursor: null, facets: null })),
	getActivityExportCsv: vi.fn(),
}));
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));

import { getActivityLog } from "@/app/server/actions/activity";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/** The org-scoped feed, with the export permission granted by the page. */
function renderFeed(): void {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ActivityLog exportPermitted />
		</QueryClientProvider>,
	);
}

/** The Export button, or null when it is not rendered. */
function exportButton(): HTMLElement | null {
	return screen.queryByRole("button", { name: /export csv/i });
}

/** Puts the store in the state `fetchWorkspace()` leaves it in once it has answered. */
function loadWorkspace(activityExport: boolean): void {
	act(() =>
		useWorkspaceStore.setState({ entitlements: { ...COMMUNITY_ENTITLEMENTS, activityExport } }),
	);
}

beforeEach(() => {
	sessionStorage.clear();
	useActivityFilters.getState().reset();
	useWorkspaceStore.setState({ entitlements: null });
});

describe("Activity export before the workspace store has loaded (#5864)", () => {
	it("renders no Export button while the entitlement is unknown", async () => {
		renderFeed();
		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		expect(exportButton()).toBeNull();
		expect(screen.queryByTitle(/requires the Enterprise plan/i)).toBeNull();
	});

	it("enables Export once the store says the org is entitled", async () => {
		renderFeed();
		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		loadWorkspace(true);
		const button = exportButton();
		expect(button).not.toBeNull();
		expect(button?.hasAttribute("disabled")).toBe(false);
	});

	it("disables Export with the upgrade reason once the store says the org is not entitled", async () => {
		renderFeed();
		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		loadWorkspace(false);
		const button = exportButton();
		expect(button?.hasAttribute("disabled")).toBe(true);
		expect(button?.getAttribute("title")).toMatch(/requires the Enterprise plan/i);
	});
});
