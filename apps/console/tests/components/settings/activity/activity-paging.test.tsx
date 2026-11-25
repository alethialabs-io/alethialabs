// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity on the console's one keyset contract (LST-10 #7492, epic #7481). Drives the
// REAL `ActivityLog` — `useKeysetList` + `ListFooter` over a fake `activity.page` that pages exactly
// as the builder does: the shared codec's cursor and the shared in-memory pager (the SQL builder's
// order, `ts` to the millisecond then id, both descending). What is locked here:
//
//   · a walk across page boundaries that fall INSIDE a tie on `ts` shows every event exactly once;
//   · a filter change restarts at page one — no cursor from the previous walk reaches it;
//   · the footer's states: "Load more" while there is more, busy while a page loads, nothing at
//     the end (no "That's all N"), and no count pill anywhere;
//   · a live hint (the `activity` topic, ADR 0005) that lands a new event refetches from page one
//     and draws every event once.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeKeysetCursor, keysetPageInMemory } from "@/lib/queries/keyset";

vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/activity",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/components/org/upgrade-sheet-provider", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/org/upgrade-sheet-provider")>()),
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));
vi.mock("@/app/server/actions/activity", () => ({ getActivityExportCsv: vi.fn() }));

const ADA = "00000000-0000-4000-8000-0000000000aa";
const GRACE = "00000000-0000-4000-8000-0000000000bb";

/** The page size of the fake read: small, so a handful of events spans several pages. */
const LIMIT = 2;

const h = vi.hoisted(() => {
	const state: {
		/** The events "in the database". */
		events: Array<{ id: number; actorId: string; ts: string }>;
		inputs: unknown[];
		/** When set, a LATER page waits on this before answering (the footer's busy state). */
		hold: Promise<void> | null;
	} = { events: [], inputs: [], hold: null };
	return state;
});

/** The `activity.page` input's fields this fake reads. */
function fieldsOf(input: unknown): { cursor?: string; actorIds?: string[] } {
	if (typeof input !== "object" || input === null) return {};
	const cursor = "cursor" in input && typeof input.cursor === "string" ? input.cursor : undefined;
	const actorIds =
		"actorIds" in input && Array.isArray(input.actorIds)
			? input.actorIds.filter((a): a is string => typeof a === "string")
			: undefined;
	return { cursor, actorIds };
}

/** The builder's contract over `h.events`: actor filter, keyset page, first-page-only extras. */
async function serve(input: unknown) {
	h.inputs.push(input);
	const { cursor: raw, actorIds } = fieldsOf(input);
	const cursor = raw === undefined ? undefined : decodeKeysetCursor(raw, "integer");
	if (cursor === null) throw new Error("400: malformed cursor");
	if (cursor !== undefined && h.hold) await h.hold;
	const universe = h.events.filter((e) => !actorIds || actorIds.includes(e.actorId));
	const page = keysetPageInMemory(universe, { cursor, limit: LIMIT }, (e) => ({ at: e.ts, id: e.id }), "integer");
	const first = cursor === undefined;
	return {
		rows: page.rows.map((e) => ({
			id: String(e.id),
			actorId: e.actorId,
			actorName: `Actor ${e.id}`,
			actorEmail: null,
			actorImage: null,
			actorUsername: null,
			action: "update",
			resourceType: "project",
			resourceId: null,
			resourceName: null,
			decision: true,
			reason: null,
			ts: e.ts,
		})),
		nextCursor: page.nextCursor,
		facets: first ? { actors: [], projects: [], resourceTypes: [], decisions: [] } : null,
		universeEmpty: first ? h.events.length === 0 : null,
	};
}

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.list": async () => [],
			"activity.page": (input) => serve(input),
		}).orpc,
	};
});

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";

/** An instant `secondsAgo` before now, at ms precision — inside the default window. */
function ago(secondsAgo: number): string {
	return new Date(Math.floor(Date.now() / 1000) * 1000 - secondsAgo * 1000).toISOString();
}

/** The actor names on screen, top to bottom — one per rendered event. */
function shown(): string[] {
	return screen.queryAllByText(/^Actor \d+$/).map((el) => el.textContent ?? "");
}

let client: QueryClient;

/** Renders the real feed under a fresh QueryClient. */
function render() {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return rtlRender(
		<QueryClientProvider client={client}>
			<ActivityLog />
		</QueryClientProvider>,
	);
}

/** Clicks "Load more" until the footer stops offering it. */
async function walkToTheEnd(user: ReturnType<typeof userEvent.setup>) {
	for (let i = 0; i < 10; i++) {
		const more = screen.queryByRole("button", { name: /load more/i });
		if (!more) return;
		const before = shown().length;
		await user.click(more);
		await waitFor(() => expect(shown().length).toBeGreaterThan(before));
	}
	throw new Error("the walk never ended");
}

beforeEach(() => {
	sessionStorage.clear();
	useActivityFilters.getState().reset();
	h.inputs = [];
	h.hold = null;
	// Seven events; four share ONE instant, so a page of two has boundaries inside the tie.
	const tie = ago(20);
	h.events = [
		{ id: 1, actorId: ADA, ts: ago(30) },
		{ id: 2, actorId: GRACE, ts: ago(30) },
		{ id: 3, actorId: ADA, ts: tie },
		{ id: 4, actorId: GRACE, ts: tie },
		{ id: 5, actorId: ADA, ts: tie },
		{ id: 6, actorId: GRACE, ts: tie },
		{ id: 7, actorId: ADA, ts: ago(10) },
	];
});

describe("Activity paging — the shared keyset contract (LST-10)", () => {
	it("walks every event exactly once across page boundaries inside a tie, newest first", async () => {
		const user = userEvent.setup();
		render();
		await waitFor(() => expect(shown()).toEqual(["Actor 7", "Actor 6"]));
		await walkToTheEnd(user);
		// Newest first; inside the tie the id breaks it, descending.
		expect(shown()).toEqual(["Actor 7", "Actor 6", "Actor 5", "Actor 4", "Actor 3", "Actor 2", "Actor 1"]);
		// Page one carried no cursor; every later page carried the previous page's, verbatim.
		expect(fieldsOf(h.inputs[0]).cursor).toBeUndefined();
		expect(h.inputs.slice(1).every((i) => fieldsOf(i).cursor !== undefined)).toBe(true);
	});

	it("a filter change restarts at page one: no cursor from the previous walk reaches it", async () => {
		const user = userEvent.setup();
		render();
		await waitFor(() => expect(shown()).toHaveLength(2));
		await user.click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(shown()).toHaveLength(4));

		const sent = h.inputs.length;
		act(() => useActivityFilters.getState().set("actorIds", [GRACE]));
		await waitFor(() => expect(shown()).toEqual(["Actor 6", "Actor 4"]));
		const after = h.inputs.slice(sent);
		expect(after.length).toBeGreaterThan(0);
		expect(fieldsOf(after[0])).toEqual({ cursor: undefined, actorIds: [GRACE] });
	});

	it("footer: Load more while there is more, busy while a page loads, nothing at the end", async () => {
		const user = userEvent.setup();
		let release: () => void = () => {};
		h.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		render();
		const more = await screen.findByRole("button", { name: /load more/i });
		await user.click(more);
		await waitFor(() => expect(screen.getByRole("button", { name: /load more/i })).toBeDisabled());
		expect(screen.getByRole("button", { name: /load more/i })).toHaveAttribute("aria-busy", "true");

		release();
		h.hold = null;
		await waitFor(() => expect(shown()).toHaveLength(4));
		await walkToTheEnd(user);
		// The end is nothing: no button, no "That's all", and no count — not in the toolbar either.
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
		expect(document.querySelector('[data-slot="list-footer"]')).toBeNull();
		expect(document.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(screen.queryByText(/that's all/i)).toBeNull();
	});

	it("a live hint that lands a new event refetches from page one and draws every event once", async () => {
		const user = userEvent.setup();
		render();
		await waitFor(() => expect(shown()).toHaveLength(2));
		await user.click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(shown()).toHaveLength(4));

		h.events = [...h.events, { id: 8, actorId: GRACE, ts: ago(1) }];
		await act(async () => {
			for (const queryKey of TOPIC_KEYS.activity()) await client.invalidateQueries({ queryKey });
		});
		await waitFor(() => expect(shown()[0]).toBe("Actor 8"));
		const names = shown();
		expect(new Set(names).size).toBe(names.length);
		// The refetch re-walks the pages it had, from page one, so nothing between them is skipped.
		expect(names).toEqual(["Actor 8", "Actor 7", "Actor 6", "Actor 5"]);
	});
});
