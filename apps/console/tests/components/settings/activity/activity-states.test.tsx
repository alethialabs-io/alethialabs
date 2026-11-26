// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity, CON-L10. Drives the REAL `ActivityLog`; only the network edges are mocked.
//
//   · E-26 — a failed "Load more" keeps every loaded row and says so under them, with a retry
//            (the shared `ListFooter`'s line since LST-10 #7492);
//   · E-27 — an empty feed is one of three answers: filtered, a new organization (the first page's
//            `universeEmpty`), a quiet window;
//   · E-28 — the page opens with its toolbar (description, no count), not a heading naming the page.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	// The link is the feed's first source of truth (#6320), so a filtered view is a filtered link.
	useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
// The Activity feed opens the shell's ONE upgrade sheet (R6 F-31); the provider is the org layout's.
vi.mock("@/components/org/upgrade-sheet-provider", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/org/upgrade-sheet-provider")>()),
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/app/server/actions/activity", () => ({ getActivityExportCsv: vi.fn() }));

const h = vi.hoisted(() => ({ page: vi.fn<(input: unknown) => Promise<unknown>>() }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.list": async () => [],
			"activity.page": (input) => h.page(input),
		}).orpc,
	};
});

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";

/** One activity row, as `activity.page` returns it. */
function row(id: number) {
	return {
		id: String(id),
		ts: "2026-01-01T00:00:00.000Z",
		actorId: "u1",
		actorName: "Ada Lovelace",
		actorEmail: "ada@example.test",
		actorUsername: null,
		actorImage: null,
		action: "update",
		resourceType: "project",
		resourceId: `p${id}`,
		resourceName: `project ${id}`,
		decision: true,
		reason: null,
	};
}

/** Facets whose decision counts add up to `total` — the scope's whole log. */
function facets(total: number) {
	return {
		actors: [],
		projects: [],
		resourceTypes: [],
		decisions: [{ value: "allow", label: "allow", count: total }],
	};
}

/** A first page, as the keyset builder returns it: rows, cursor, facets and universeEmpty. */
function firstPage(rows: ReturnType<typeof row>[], total: number, nextCursor: string | null = null) {
	return { rows, nextCursor, facets: facets(total), universeEmpty: total === 0 };
}

/** Long enough for useKeysetList's one retry of a real failure (TanStack's first back-off is 1s). */
const RETRIED = { timeout: 4000 };

/** Renders under a fresh QueryClient (retries off so a rejection fails fast). */
function render() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return rtlRender(
		<QueryClientProvider client={client}>
			<ActivityLog />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	sessionStorage.clear();
	useActivityFilters.getState().reset();
	h.page.mockReset();
	nav.search = "";
});

describe("a failed Load more keeps the loaded rows (R6 E-26)", () => {
	it("says the older page failed under the rows, and retries it", async () => {
		const user = userEvent.setup();
		h.page.mockImplementation(async (input) => {
			const cursor = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
			if (cursor === undefined || cursor === null) return firstPage([row(2)], 2, "c1");
			throw new Error("network");
		});
		render();
		const more = await screen.findByRole("button", { name: /load more/i });
		await user.click(more);
		expect(await screen.findByText(/Couldn't load more/, undefined, RETRIED)).toBeInTheDocument();
		// The loaded row is still on screen; no page-wide error replaced it.
		expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
		expect(screen.queryByText("Couldn't load activity")).toBeNull();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
	});
});

describe("the three empty answers (R6 E-27)", () => {
	it("a new organization: no activity yet", async () => {
		h.page.mockResolvedValue(firstPage([], 0));
		render();
		expect(await screen.findByText("No activity yet")).toBeInTheDocument();
	});

	it("a quiet window: nothing recorded in this time range", async () => {
		h.page.mockResolvedValue(firstPage([], 12));
		render();
		expect(await screen.findByText("Nothing recorded in this time range")).toBeInTheDocument();
	});

	it("a filter that matches nothing: the pinned sentence, with Clear filters", async () => {
		h.page.mockResolvedValue(firstPage([], 12));
		nav.search = "eventTokens=result:deny";
		render();
		await waitFor(() => expect(screen.getByText("No activity matches these filters.")).toBeInTheDocument());
		expect(screen.getAllByRole("button", { name: /clear filters/i }).length).toBeGreaterThan(0);
	});
});

describe("the page opens with its one toolbar row (R6 E-28, polish-wave §3)", () => {
	it("has no heading naming the page and no description line; the search leads the row", async () => {
		h.page.mockResolvedValue(firstPage([row(1)], 1));
		render();
		await waitFor(() => expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0));
		expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
		// No count anywhere in the toolbar: a keyset feed only knows what it LOADED (#7481).
		expect(document.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(screen.queryByText("Every recorded action and access decision in this organization.")).toBeNull();
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		// The row starts with the search box: it is the first control of its row.
		const search = document.querySelector('[data-slot="filter-search"]');
		expect(search?.parentElement?.firstElementChild).toBe(search);
		expect(screen.getByPlaceholderText("Search actor, action or resource…")).toBeInTheDocument();
	});
});
