// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7484 — the runners grid's paging, end to end through the client half: the REAL oRPC TanStack
// utils and `useKeysetList`, asked with `normalizeRunnersQuery`'s output exactly as `RunnersClient`
// asks, over a fake `runners.page` that answers with the REAL builder (`queryRunnersPage`, which
// pages the composed universe in memory on the server). It replaces the old `?page=` test: the
// grid used to receive the whole fleet and `.slice` it nine cards at a time. What is locked here:
//   · every runner is reachable: a fleet larger than one page walks to the oldest runner, each
//     exactly once, across page boundaries that fall INSIDE runs of runners sharing one instant;
//   · a filter change (and Reset) restarts at page one, with no cursor from the old walk, and the
//     facets stay the unfiltered universe's;
//   · LIVE (ADR 0005): a `runners` hint (the real `TOPIC_KEYS.runners()` keys) re-reads the loaded
//     pages; a runner registered meanwhile arrives first, none is drawn twice, none already loaded
//     is lost, and the walk continues to the end from the refetched boundary.

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DEFAULT_RUNNER_FILTERS, normalizeRunnersQuery, type RunnerPageFilters } from "@/components/runners/runners-query";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import { queryRunnersPage, type RunnerFacts, type RunnersQuery } from "@/lib/queries/runners";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { useKeysetList } from "@/lib/query/use-keyset-list";

/** A runner as the fake read holds it: the facts the builder reads plus its sort key. */
type Runner = RunnerFacts & { created_at: string };

type Input = RunnersQuery & { cursor?: string; limit?: number };

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** One runner, number `n`, created at `at`. Every third is managed; every fifth is on gcp. */
function runner(n: number, at: string): Runner {
	return {
		id: uuid(n),
		name: `runner-${n}`,
		status: "ONLINE",
		operator: n % 3 === 0 ? "managed" : "self",
		provisioning: n % 3 === 0 ? null : "deployed",
		supported_providers: n % 5 === 0 ? ["gcp"] : ["aws"],
		location: "eu-central-1",
		version: "1.0.0",
		runner_releases: null,
		created_at: at,
	};
}

/** `n` runners, FOUR to an instant (so a 50-row boundary lands inside a run of ties). Higher n = newer. */
function fleet(n: number): Runner[] {
	return Array.from({ length: n }, (_, i) =>
		runner(i + 1, new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 4) * 1000).toISOString()),
	);
}

/** The fake `runners.page`: the real builder over `universe()`, read fresh on every call. */
function server(universe: () => Runner[]) {
	return async (input: Input) => {
		const { cursor: raw, limit = 50, ...query } = input;
		const cursor = raw === undefined ? undefined : (decodeKeysetCursor(raw, "uuid") ?? undefined);
		if (raw !== undefined && cursor === undefined) throw new Error("400: malformed cursor");
		return queryRunnersPage(universe(), query, { cursor, limit }, (r) => ({ at: r.created_at, id: r.id }));
	};
}

/** The real oRPC utils over the fake transport, and a client to render against. */
function harness(universe: () => Runner[]) {
	const page = vi.fn(server(universe));
	const utils = createTanstackQueryUtils({ runners: { page: (input: Input) => page(input) } });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { page, utils, client, wrapper };
}

/** The grid's query for a filter state, with the search already debounced. */
function queryOf(filters: RunnerPageFilters): RunnersQuery {
	return normalizeRunnersQuery(filters, filters.search);
}

/** Pulls pages until the list says there are no more. */
async function walkToTheEnd(result: { current: { hasMore: boolean; loadingMore: boolean; loadMore: () => void } }) {
	for (let guard = 0; result.current.hasMore && guard < 100; guard++) {
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.loadingMore).toBe(false));
	}
}

describe("the runners grid pages by keyset", () => {
	it("reaches every runner in the fleet, each once, through page boundaries inside runs of ties", async () => {
		const universe = fleet(130);
		const { utils, wrapper, page } = harness(() => universe);
		const query = queryOf(DEFAULT_RUNNER_FILTERS);
		const { result } = renderHook(() => useKeysetList(utils.runners.page, query), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		expect(result.current.hasMore).toBe(true);
		await walkToTheEnd(result);

		const ids = result.current.rows.map((r) => r.id);
		expect(ids).toHaveLength(130);
		expect(new Set(ids).size).toBe(130);
		// Newest first, ties by id descending — so the last row is the OLDEST runner, uuid(1).
		expect(ids[0]).toBe(uuid(130));
		expect(ids.at(-1)).toBe(uuid(1));
		expect(ids).toEqual([...ids].sort().reverse());
		expect(result.current.hasMore).toBe(false);
		// Three pages of at most 50; only the first carried no cursor, and none named a page size.
		expect(page).toHaveBeenCalledTimes(3);
		expect(page.mock.calls.map(([input]) => "cursor" in input)).toEqual([false, true, true]);
		expect(page.mock.calls.every(([input]) => input.limit === undefined)).toBe(true);
	});

	it("a filter change restarts at page one; Reset restarts it again; facets stay the whole fleet's", async () => {
		const universe = fleet(120);
		const { utils, wrapper, page } = harness(() => universe);
		const { result, rerender } = renderHook(
			({ filters }: { filters: RunnerPageFilters }) => useKeysetList(utils.runners.page, queryOf(filters)),
			{ wrapper, initialProps: { filters: DEFAULT_RUNNER_FILTERS } },
		);
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(100));
		const pristineFacets = result.current.facets;

		page.mockClear();
		rerender({ filters: { ...DEFAULT_RUNNER_FILTERS, clouds: ["gcp"] } });
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
		expect(page).toHaveBeenCalledTimes(1);
		expect(page.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
		expect(result.current.rows).toHaveLength(24);
		expect(result.current.rows.every((r) => r.supported_providers?.includes("gcp"))).toBe(true);
		expect(result.current.hasMore).toBe(false);
		// The facet pass never saw the filter: the aws option the user did not pick is still offered.
		expect(result.current.facets).toEqual(pristineFacets);
		expect(result.current.facets?.clouds).toEqual([
			{ value: "aws", label: null, count: 96 },
			{ value: "gcp", label: null, count: 24 },
		]);

		// Reset: back to the pristine key, whose walk starts at the newest runner again — the gcp
		// walk's position does not carry over.
		rerender({ filters: DEFAULT_RUNNER_FILTERS });
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
		expect(result.current.rows[0]?.id).toBe(uuid(120));
		expect(result.current.rows.some((r) => !r.supported_providers?.includes("gcp"))).toBe(true);
		expect(result.current.hasMore).toBe(true);
	});

	it("LIVE: a runner registered meanwhile arrives first on a runners hint; nothing is drawn twice or lost", async () => {
		let universe = fleet(130);
		const { utils, client, wrapper } = harness(() => universe);
		const query = queryOf(DEFAULT_RUNNER_FILTERS);
		const { result } = renderHook(() => useKeysetList(utils.runners.page, query), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(100));
		const before = result.current.rows.map((r) => r.id);

		// A runner registers — newer than every card on screen — and the change stream sends a
		// `runners` hint, which invalidates the REAL topic keys (lib/query/topics.ts).
		const fresh = runner(9999, "2026-11-24T12:00:00.000Z");
		universe = [fresh, ...universe];
		for (const queryKey of TOPIC_KEYS.runners()) await act(() => client.invalidateQueries({ queryKey }));
		await waitFor(() => expect(result.current.rows[0]?.id).toBe(fresh.id));

		const after = result.current.rows.map((r) => r.id);
		expect(new Set(after).size).toBe(after.length);
		// The loaded pages were re-read from the top: the new runner first, then the same cards in the
		// same order, the last one pushed onto the next page rather than lost.
		expect(after).toEqual([fresh.id, ...before.slice(0, after.length - 1)]);
		expect(result.current.hasMore).toBe(true);

		await walkToTheEnd(result);
		const all = result.current.rows.map((r) => r.id);
		expect(all).toHaveLength(131);
		expect(new Set(all).size).toBe(131);
		expect(all.at(-1)).toBe(uuid(1));
	});

	it("LIVE: a runner removed meanwhile drops out on the hint, and no card is drawn twice", async () => {
		let universe = fleet(80);
		const { utils, client, wrapper } = harness(() => universe);
		const query = queryOf(DEFAULT_RUNNER_FILTERS);
		const { result } = renderHook(() => useKeysetList(utils.runners.page, query), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(80));

		universe = universe.filter((r) => r.id !== uuid(70));
		for (const queryKey of TOPIC_KEYS.runners()) await act(() => client.invalidateQueries({ queryKey }));
		await waitFor(() => expect(result.current.rows).toHaveLength(79));
		const ids = result.current.rows.map((r) => r.id);
		expect(ids).not.toContain(uuid(70));
		expect(new Set(ids).size).toBe(79);
	});
});
