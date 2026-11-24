// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// useKeysetList (lib/query/use-keyset-list.ts, #7482) over the REAL oRPC TanStack utils and a fake
// transport, so the key under test is the key the browser builds. What is locked here:
//   - the cursor is the pageParam: never in the query key, so page one's key is the filter alone;
//   - "load more" walks the server's cursor and keeps the first page's facets;
//   - a filter change restarts the walk at page one (no stale cursor reaches the new filter);
//   - a failed LATER page keeps every loaded row and is NOT a first-page error;
//   - rows are joined keeping each id once.

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { decodeKeysetCursor, keysetPageInMemory, type KeysetListPage } from "@/lib/queries/keyset";
import { useKeysetList } from "@/lib/query/use-keyset-list";

interface Thing {
	id: string;
	kind: string;
	at: string;
}

interface ThingFacets {
	kind: string[];
}

interface ThingInput {
	kind: string;
	cursor?: string;
	limit?: number;
}

/** Long enough for the hook's one retry of a real failure (TanStack's first back-off is 1s). */
const RETRIED = 4000;

/** A uuid whose trailing digits are `n`. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Five "a" things and three "b" things, a second apart, newest = highest n. */
const UNIVERSE: Thing[] = [
	...[1, 2, 3, 4, 5].map((n) => ({ id: uuid(n), kind: "a", at: new Date(Date.UTC(2026, 10, 20, 10, 0, n)).toISOString() })),
	...[6, 7, 8].map((n) => ({ id: uuid(n), kind: "b", at: new Date(Date.UTC(2026, 10, 20, 10, 0, n)).toISOString() })),
];

/** The fake server: the builder contract over UNIVERSE, two rows a page. */
function serve(input: ThingInput): KeysetListPage<Thing, ThingFacets> {
	const cursor = input.cursor === undefined ? undefined : (decodeKeysetCursor(input.cursor) ?? undefined);
	if (input.cursor !== undefined && cursor === undefined) throw new Error("400: malformed cursor");
	const page = keysetPageInMemory(
		UNIVERSE.filter((t) => t.kind === input.kind),
		{ cursor, limit: 2 },
		(t) => t,
	);
	const first = cursor === undefined;
	return {
		...page,
		facets: first ? { kind: ["a", "b"] } : null,
		universeEmpty: first ? UNIVERSE.length === 0 : null,
	};
}

/** Builds the oRPC utils over a fake transport whose answers the test controls. */
function harness(answer: (input: ThingInput) => Promise<KeysetListPage<Thing, ThingFacets>> = async (input) => serve(input)) {
	const page = vi.fn(answer);
	const utils = createTanstackQueryUtils({ things: { page: (input: ThingInput) => page(input) } });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	return { page, utils, client, wrapper };
}

describe("useKeysetList", () => {
	it("page one: rows, facets and universeEmpty, and the cursor is NOT in the key", async () => {
		const { utils, client, wrapper, page } = harness();
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }), { wrapper });
		expect(result.current.isPending).toBe(true);
		await waitFor(() => expect(result.current.isPending).toBe(false));
		expect(result.current.rows.map((r) => r.id)).toEqual([uuid(5), uuid(4)]);
		expect(result.current.facets).toEqual({ kind: ["a", "b"] });
		expect(result.current.universeEmpty).toBe(false);
		expect(result.current.hasMore).toBe(true);
		expect(page).toHaveBeenCalledWith({ kind: "a" });
		const keys = client.getQueryCache().getAll().map((q) => JSON.stringify(q.queryKey));
		expect(keys).toHaveLength(1);
		expect(keys[0]).toContain('"kind":"a"');
		expect(keys[0]).not.toContain("cursor");
	});

	it("loadMore walks the cursor to the end; facets stay the first page's", async () => {
		const { utils, wrapper } = harness();
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(2));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(4));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(result.current.rows.map((r) => r.id)).toEqual([5, 4, 3, 2, 1].map(uuid));
		expect(result.current.hasMore).toBe(false);
		expect(result.current.facets).toEqual({ kind: ["a", "b"] });
		// At the end, loadMore is a no-op rather than a request for a page that does not exist.
		act(() => result.current.loadMore());
		expect(result.current.loadingMore).toBe(false);
	});

	it("a filter change restarts at page one — no cursor from the old walk reaches the new filter", async () => {
		const { utils, wrapper, page } = harness();
		const { result, rerender } = renderHook(({ kind }) => useKeysetList(utils.things.page, { kind }), {
			wrapper,
			initialProps: { kind: "a" },
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(2));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(4));

		rerender({ kind: "b" });
		// keepPreviousData: the old rows stay, dimmed, until the new first page lands — and no
		// "Load more" is offered on them, because their cursor belongs to the old walk.
		expect(result.current.isPlaceholderData).toBe(true);
		expect(result.current.hasMore).toBe(false);
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
		expect(result.current.rows.map((r) => r.id)).toEqual([uuid(8), uuid(7)]);
		expect(page).toHaveBeenLastCalledWith({ kind: "b" });
	});

	it("a failed LATER page keeps the rows, is not a first-page error, and retries through loadMore", async () => {
		let failNext = false;
		const { utils, wrapper } = harness(async (input) => {
			if (input.cursor !== undefined && failNext) throw new Error("boom");
			return serve(input);
		});
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(2));
		failNext = true;
		act(() => result.current.loadMore());
		// The hook retries a real failure once (`retryUnlessRefused`), after TanStack's 1s back-off.
		await waitFor(() => expect(result.current.loadMoreFailed).toBe(true), { timeout: RETRIED });
		expect(result.current.rows).toHaveLength(2);
		expect(result.current.query.isError).toBe(false);
		expect(result.current.hasMore).toBe(true);

		failNext = false;
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows).toHaveLength(4));
		expect(result.current.loadMoreFailed).toBe(false);
	});

	it("a failed FIRST page is the query's error, with no rows", async () => {
		const { utils, wrapper } = harness(async () => {
			throw new Error("down");
		});
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }), { wrapper });
		await waitFor(() => expect(result.current.query.isError).toBe(true), { timeout: RETRIED });
		expect(result.current.rows).toEqual([]);
		expect(result.current.loadMoreFailed).toBe(false);
	});

	it("joins pages keeping each id once", async () => {
		// Page two repeats page one's last row — what a re-ordered refetch can produce.
		const { utils, wrapper } = harness(async (input) => {
			const served = serve(input);
			if (input.cursor === undefined) return served;
			return { ...served, rows: [UNIVERSE[3], ...served.rows] };
		});
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }), { wrapper });
		await waitFor(() => expect(result.current.rows).toHaveLength(2));
		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(2));
		const ids = result.current.rows.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([5, 4, 3, 2].map(uuid));
	});

	it("enabled: false holds the read and settles instead of loading forever", () => {
		const { utils, wrapper, page } = harness();
		const { result } = renderHook(() => useKeysetList(utils.things.page, { kind: "a" }, { enabled: false }), { wrapper });
		expect(page).not.toHaveBeenCalled();
		expect(result.current.query.isLoading).toBe(false);
	});
});
