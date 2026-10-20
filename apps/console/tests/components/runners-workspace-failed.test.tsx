// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Runners page when the workspace load FAILED (#5895).
//
// Runners waits on `useEntitlement("byoRunners")`: `null` (unknown) shows the runner skeleton,
// because neither the page nor the upsell may render before the store has answered (#5864). A
// failed load used to leave the store in the never-fetched shape, so the skeleton stayed for good —
// no error, no retry. The page now says the workspace could not be loaded and offers Retry, which
// re-runs `fetchWorkspace()` (which refetches the workspace query); and it still renders neither
// the runners nor the upsell. Since #6114 the store reaches `failed` through the shell's query sync. Real hook,
// real store; the workspace read and the page's data hooks are mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "@/lib/rpc/procedures/workspace";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/runners",
	useSearchParams: () => new URLSearchParams(""),
}));

const { readContext } = vi.hoisted(() => ({
	readContext: vi.fn<() => Promise<WorkspaceContext>>(),
}));
// The store reads the workspace over the read router's GET procedure (#6114); only that call is
// stubbed — the query helpers and the tenant partition stay real.
vi.mock("@/lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rpc/client")>()),
	rpcClient: { workspace: { context: readContext } },
}));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
// The app's per-tenant client, replaced by one without retries so a failure settles at once. The
// store's Retry refetches through `getQueryClient(...)`, so it must be the provider's client too.
const q = vi.hoisted(() => {
	const holder: { client: unknown } = { client: undefined };
	return holder;
});
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => q.client }));

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
import { orpc } from "@/lib/rpc/client";
import { useWorkspaceStore, useWorkspaceStoreSync } from "@/lib/stores/use-workspace-store";

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

/** The shell's half: settles the store from the workspace-context query (`useWorkspaceStoreSync`). */
function ShellSync(): null {
	useWorkspaceStoreSync();
	return null;
}

/**
 * Renders the Runners page under the shell's store sync with a workspace query that FAILS — the
 * path a failed layout prefetch takes on the client. Nothing calls `fetchWorkspace()` here: the
 * store must reach `failed` through the hook, as it does in the app.
 */
let client: QueryClient;

async function renderWithFailedLoad() {
	readContext.mockRejectedValueOnce(new Error("network down"));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	q.client = client;
	const view = render(
		<QueryClientProvider client={client}>
			<ShellSync />
			<RunnersClient />
		</QueryClientProvider>,
	);
	await waitFor(() => expect(useWorkspaceStore.getState().loadStatus).toBe("failed"));
	return view;
}

beforeEach(() => {
	sessionStorage.clear();
	readContext.mockReset();
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
		const { container } = await renderWithFailedLoad();
		expect(screen.getByRole("alert").textContent).toMatch(ERROR_TITLE);
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		expect(container.querySelector("[aria-busy]")).toBeNull();
	});

	it("fails closed: neither the runners page nor the upsell renders on a failed load", async () => {
		await renderWithFailedLoad();
		expect(screen.queryByText(UPSELL)).toBeNull();
		expect(screen.queryByText("Pools")).toBeNull();
		expect(screen.queryByText(/no runners/i)).toBeNull();
	});

	it("Retry re-runs the workspace load, and a successful one shows the page", async () => {
		await renderWithFailedLoad();
		readContext.mockResolvedValueOnce(context(true));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(readContext).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(screen.queryByText(ERROR_TITLE)).toBeNull());
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
		expect(screen.queryByText(UPSELL)).toBeNull();
		// The retry's answer is the QUERY's answer too: the switchers render from it, and its error
		// is gone, so the shell's sync cannot mark the store failed again.
		expect(client.getQueryState(orpc.workspace.context.queryKey())?.status).toBe("success");
	});
});
