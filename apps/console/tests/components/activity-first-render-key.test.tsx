// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6320 (B1): the Activity feed's first render asks for EXACTLY the key the route prefetched.
//
// The route prefetches the first page from the link's filters in the default window it resolved
// (`activityQueryFromUrl`). The defect this pins: the feed's filter store used to be persisted per
// browser session, so a range picked on an earlier visit overrode "Last 7 days" on load — the
// browser asked for a key the server never prefetched, fetched it, and the first paint's rows
// changed after hydration. The store also outlives a client-side navigation, which is why the
// filter state below is planted in the store directly rather than in sessionStorage.
//
// The cache is seeded under the route's key with `staleTime: Infinity`, so the only way the feed
// can read `activity.page` is by asking for a DIFFERENT key — every `calls` entry is that defect.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	calls: [] as FakeCall[],
	search: "",
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc(
			{
				"members.list": async () => [],
				"activity.page": async () => ({ rows: [], nextCursor: null, facets: null }),
			},
			h.calls,
		).orpc,
	};
});
vi.mock("@/app/server/actions/activity", () => ({ getActivityExportCsv: vi.fn() }));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) => sel({ entitlements: { quotas: { activityRetentionDays: 30 } } }),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { activityQueryFromUrl } from "@/components/settings/activity/activity-filters";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";

const DAY = 86_400_000;
const NOW = Date.now();
/** The route's server-resolved default window ("Last 7 days"). */
const DEFAULT_WINDOW = {
	from: new Date(NOW - 7 * DAY).toISOString(),
	to: new Date(NOW).toISOString(),
};
/** A range the viewer picked on an earlier visit. */
const PICKED = {
	from: new Date(NOW - DAY).toISOString(),
	to: new Date(NOW).toISOString(),
	rangeLabel: "Last 24 hours",
};

/** One row of the page the route prefetched. */
function row(id: string, actorName: string) {
	return {
		id,
		actorId: "00000000-0000-4000-8000-0000000000aa",
		actorName,
		actorEmail: null,
		actorImage: null,
		actorUsername: null,
		action: "edit",
		resourceType: "project",
		resourceId: null,
		decision: true,
		reason: null,
		ts: new Date(NOW - 60_000).toISOString(),
	};
}

/** A client holding the route's prefetched first page under the route's own key. */
function prefetchedClient(): QueryClient {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const query = activityQueryFromUrl(new URLSearchParams(h.search), DEFAULT_WINDOW);
	client.setQueryData([["activity", "page"], { input: query, type: "infinite" }], {
		pages: [{ rows: [row("1", "Ada Lovelace")], nextCursor: null, facets: null }],
		pageParams: [null],
	});
	client.setQueryData([["members", "list"], { input: undefined, type: "query" }], []);
	return client;
}

beforeEach(() => {
	h.calls.length = 0;
	h.search = "";
	useActivityFilters.getState().reset();
});

describe("Activity feed — the first render's key is the prefetched key (#6320, B1)", () => {
	it("a range left in the store by an earlier visit neither changes the first key nor survives the mount", async () => {
		useActivityFilters.getState().patch(PICKED);
		render(
			<QueryClientProvider client={prefetchedClient()}>
				<ActivityLog defaultWindow={DEFAULT_WINDOW} />
			</QueryClientProvider>,
		);

		// The first paint carries the prefetched rows — no skeleton, no fetch.
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		// The link (no range) replaced the stale selection on mount, so the feed stays on the default.
		await waitFor(() => expect(useActivityFilters.getState().filters.from).toBe(""));
		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		expect(h.calls.filter((c) => c.path === "activity.page")).toEqual([]);
	});

	it("a link that carries a range renders that range on the first paint, as the route prefetched it", async () => {
		h.search = new URLSearchParams(PICKED).toString();
		render(
			<QueryClientProvider client={prefetchedClient()}>
				<ActivityLog defaultWindow={DEFAULT_WINDOW} />
			</QueryClientProvider>,
		);

		expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
		await waitFor(() => expect(useActivityFilters.getState().filters.from).toBe(PICKED.from));
		expect(h.calls.filter((c) => c.path === "activity.page")).toEqual([]);
	});
});
