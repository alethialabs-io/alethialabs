// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7483 — the jobs list's paging, end to end through the client half: the REAL oRPC TanStack utils
// and `useKeysetList`, asked with `normalizeJobsQuery`'s output exactly as `JobsClient` asks, over a
// fake `jobs.page` that answers by the builder's contract (`keysetPageInMemory` — the same order and
// strictly-after cursor as the SQL, `lib/queries/keyset.ts`). What is locked here:
//   · every job in the scope is reachable: 620 jobs — past the old 500-row cap — walk to the oldest,
//     each exactly once, across page boundaries that fall INSIDE runs of jobs sharing one instant;
//   · a filter change restarts at page one, with no cursor from the old walk;
//   · LIVE: a `jobs` hint (the real `TOPIC_KEYS.jobs()` keys) re-reads the loaded pages; a job
//     inserted at the top arrives first, no job is drawn twice, none already loaded is lost, and
//     the walk continues to the end from the refetched boundary.

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DEFAULT_JOBS_FILTERS, type JobsListQuery, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { decodeKeysetCursor, type KeysetListPage, keysetPageInMemory } from "@/lib/queries/keyset";
import { useKeysetList } from "@/lib/query/use-keyset-list";

interface Job {
	id: string;
	status: string;
	created_at: string;
}

interface Facets {
	statuses: { value: string; label: null; count: number }[];
}

type Input = JobsListQuery & { cursor?: string; limit?: number };

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * `n` jobs, FOUR to an instant (so ties on created_at are the common case, and a 50-row page
 * boundary lands inside a run of ties), every fifth one FAILED. Higher n = newer.
 */
function jobs(n: number): Job[] {
	return Array.from({ length: n }, (_, i) => ({
		id: uuid(i + 1),
		status: (i + 1) % 5 === 0 ? "FAILED" : "SUCCESS",
		created_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 4) * 1000).toISOString(),
	}));
}

/** The fake `jobs.page`: the builder contract over `universe()`, read fresh on every call. */
function server(universe: () => Job[]) {
	return async (input: Input): Promise<KeysetListPage<Job, Facets>> => {
		const cursor = input.cursor === undefined ? undefined : (decodeKeysetCursor(input.cursor) ?? undefined);
		if (input.cursor !== undefined && cursor === undefined) throw new Error("400: malformed cursor");
		const scope = universe();
		const filtered = input.statuses ? scope.filter((j) => input.statuses?.includes(j.status)) : scope;
		const page = keysetPageInMemory(filtered, { cursor, limit: input.limit ?? 50 }, (j) => ({
			at: j.created_at,
			id: j.id,
		}));
		const first = cursor === undefined;
		const counts = new Map<string, number>();
		for (const j of scope) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
		return {
			...page,
			facets: first ? { statuses: [...counts].map(([value, count]) => ({ value, label: null, count })) } : null,
			universeEmpty: first ? scope.length === 0 : null,
		};
	};
}

/** The real oRPC utils over the fake transport, and a client to render against. */
function harness(universe: () => Job[]) {
	const page = vi.fn(server(universe));
	const utils = createTanstackQueryUtils({ jobs: { page: (input: Input) => page(input) } });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { page, utils, client, wrapper };
}

/** Pulls pages until the list says there are no more. */
async function walkToTheEnd(result: { current: { hasMore: boolean; loadingMore: boolean; loadMore: () => void } }) {
	for (let guard = 0; result.current.hasMore && guard < 100; guard++) {
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.loadingMore).toBe(false));
	}
}

describe("the jobs list pages by keyset", () => {
	it("reaches every job in the scope — 620, past the old 500 cap — each once, through runs of ties", async () => {
		const universe = jobs(620);
		const { utils, wrapper, page } = harness(() => universe);
		const query = normalizeJobsQuery(DEFAULT_JOBS_FILTERS);
		const { result } = renderHook(() => useKeysetList(utils.jobs.page, query), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		await walkToTheEnd(result);

		const ids = result.current.rows.map((r) => r.id);
		expect(ids).toHaveLength(620);
		expect(new Set(ids).size).toBe(620);
		// Newest first, ties by id descending — so the last row is the OLDEST job, uuid(1).
		expect(ids[0]).toBe(uuid(620));
		expect(ids.at(-1)).toBe(uuid(1));
		expect(ids).toEqual([...ids].sort().reverse());
		expect(result.current.hasMore).toBe(false);
		// 13 pages of at most 50, and never a bigger window: no request carried a limit.
		expect(page).toHaveBeenCalledTimes(13);
		expect(page.mock.calls.every(([input]) => input.limit === undefined)).toBe(true);
	});

	it("a filter change restarts at page one: no cursor from the old walk reaches the new filter", async () => {
		const universe = jobs(200);
		const { utils, wrapper, page } = harness(() => universe);
		const { result, rerender } = renderHook(
			({ statuses }: { statuses: string[] }) =>
				useKeysetList(utils.jobs.page, normalizeJobsQuery({ ...DEFAULT_JOBS_FILTERS, statuses })),
			{ wrapper, initialProps: { statuses: new Array<string>() } },
		);
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(100));

		page.mockClear();
		rerender({ statuses: ["FAILED"] });
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
		expect(page).toHaveBeenCalledTimes(1);
		expect(page.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
		expect(result.current.rows).toHaveLength(40);
		expect(result.current.rows.every((r) => r.status === "FAILED")).toBe(true);
		// Facets are the unfiltered scope's, whatever the filter.
		expect(result.current.facets?.statuses).toEqual(
			expect.arrayContaining([
				{ value: "SUCCESS", label: null, count: 160 },
				{ value: "FAILED", label: null, count: 40 },
			]),
		);
	});

	it("LIVE: a job inserted at the top arrives first on a jobs hint; nothing is drawn twice or lost", async () => {
		let universe = jobs(130);
		const { utils, client, wrapper } = harness(() => universe);
		const query = normalizeJobsQuery(DEFAULT_JOBS_FILTERS);
		const { result } = renderHook(() => useKeysetList(utils.jobs.page, query), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(100));
		const before = result.current.rows.map((r) => r.id);

		// A new job lands — newer than every row on screen — and the change stream sends a `jobs` hint,
		// which invalidates the REAL topic keys (lib/query/topics.ts).
		const fresh: Job = { id: uuid(9999), status: "SUCCESS", created_at: "2026-11-24T12:00:00.000Z" };
		universe = [fresh, ...universe];
		for (const queryKey of TOPIC_KEYS.jobs()) await act(() => client.invalidateQueries({ queryKey }));
		await waitFor(() => expect(result.current.rows[0]?.id).toBe(fresh.id));

		const after = result.current.rows.map((r) => r.id);
		expect(new Set(after).size).toBe(after.length);
		// The loaded pages were re-read from the top: the new job first, then the same rows in the
		// same order, the last one pushed onto the next page rather than lost.
		expect(after).toEqual([fresh.id, ...before.slice(0, after.length - 1)]);
		expect(result.current.hasMore).toBe(true);

		await walkToTheEnd(result);
		const all = result.current.rows.map((r) => r.id);
		expect(all).toHaveLength(131);
		expect(new Set(all).size).toBe(131);
		expect(all.at(-1)).toBe(uuid(1));
	});
});
