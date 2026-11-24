"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The client half of the console list paging contract (lib/query/README.md → "Paging"; #7482).
//
// One hook every keyset list reads through, so the rules are made once:
//   - the CURSOR is the infinite query's pageParam, never part of the key and never in the URL —
//     oRPC's infinite key is `[path, { input: input(initialPageParam), type: "infinite" }]`, and the
//     initial page param is null, so the key is the filter object alone;
//   - a FILTER change is a new key, so the walk restarts at page one (TanStack starts a fresh
//     infinite query per key) — never a stale cursor applied to a different filter;
//   - `keepPreviousData`: while the new filter's first page loads, the old rows stay on screen and
//     `isPlaceholderData` is true (the README's `opacity-60` dim);
//   - a failed LATER page keeps every loaded row and is told by `ListFooter`, not by a region error;
//     a failed first page is the region error; a failed refresh behind rows is DataTable's stale
//     notice. Three different failures, three different answers, decided here once.
//
// Rows are joined across pages keeping each id once (its first occurrence): a refetch of an early
// page can lift a row that a later page still holds — a reply moves a case to the top — and the
// list must not draw it twice (the support list's `mergeCasePages`, #7389).

import type { ProcedureUtils } from "@orpc/tanstack-query";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { KeysetListPage } from "@/lib/queries/keyset";
import { retryUnlessRefused } from "@/lib/rpc/refusal";

/**
 * The read router's client context: none (`lib/rpc/client.ts` builds a plain `RouterClient`). Fixed
 * rather than generic, because oRPC types `context` as required-or-optional through a conditional
 * on this parameter, which a generic leaves unresolved inside the hook.
 */
type ReadClientContext = Record<never, never>;

/** The paging fields a keyset procedure's input carries next to its filters (`keysetPageInput()`). */
export interface KeysetCursorInput {
	cursor?: string;
	limit?: number;
}

/**
 * The slice of the first page's state a table or region reads. Shaped like `DataTableQuery`
 * (`components/data-table.tsx`), so `<DataTable keyset={list}>` and a hand-built card grid derive
 * loading / error / stale from the same answer. `isError` here is a FIRST-PAGE or REFRESH failure
 * only: a failed later page is {@link KeysetList.loadMoreFailed}, which `ListFooter` tells.
 */
export interface KeysetListQuery {
	isLoading: boolean;
	isError: boolean;
	data?: unknown;
	error: unknown;
	refetch: () => unknown;
}

/** Everything a list surface renders from: rows, the first page's facets, and the footer's state. */
export interface KeysetList<Row, Facets = unknown> {
	/** Every loaded row, across pages, each id once. */
	rows: Row[];
	/** The facet pass over the unfiltered universe — from the first page; null until it lands. */
	facets: Facets | null;
	/** First page only: true = nothing in scope at all (first-run empty), false = filtered empty. */
	universeEmpty: boolean | null;
	/** The first page's status, for the region / DataTable body. */
	query: KeysetListQuery;
	/** No first page yet (the skeleton). */
	isPending: boolean;
	/** The rows on screen belong to the PREVIOUS filters (dim them, `opacity-60`). */
	isPlaceholderData: boolean;
	/** A further page exists. Unknown-after-failure counts as true: the end has not been seen. */
	hasMore: boolean;
	/** A later page is in flight. */
	loadingMore: boolean;
	/** The last later-page request failed; the loaded rows stay. */
	loadMoreFailed: boolean;
	/** Ask for the next page. A no-op while one is in flight or when there is none. */
	loadMore: () => void;
}

/** Joins pages, keeping each row id once (its first occurrence). */
function joinPages<Row extends { id: string | number }>(pages: readonly { rows: readonly Row[] }[]): Row[] {
	if (pages.length === 1) return [...(pages[0]?.rows ?? [])];
	const seen = new Set<string>();
	const out: Row[] = [];
	for (const page of pages) {
		for (const row of page.rows) {
			const key = String(row.id);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(row);
		}
	}
	return out;
}

/** Stable empty result, so a pending list does not hand a fresh `[]` to every memo downstream. */
const NO_ROWS: never[] = [];

/**
 * Reads one keyset list: `useKeysetList(orpc.jobs.page, query)`. `procedure` is an oRPC
 * procedure's TanStack utils whose output is a {@link KeysetListPage}; `filter` is the
 * NORMALIZED filter query (`normalize*Query`), which is the whole of the key. Pass
 * `enabled: false` to hold the read (a disabled list settles to empty, never an endless skeleton).
 */
export function useKeysetList<
	TFilter extends object,
	Row extends { id: string | number },
	Facets,
	TError,
>(
	procedure: ProcedureUtils<ReadClientContext, TFilter & KeysetCursorInput, KeysetListPage<Row, Facets>, TError>,
	filter: TFilter,
	options: { enabled?: boolean } = {},
): KeysetList<Row, Facets> {
	const result = useInfiniteQuery(
		procedure.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? filter : { ...filter, cursor }),
			initialPageParam: null,
			getNextPageParam: (last: KeysetListPage<Row, Facets>) => last.nextCursor,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
			enabled: options.enabled ?? true,
		}),
	);

	const { data, fetchNextPage, refetch, isFetchingNextPage, isFetchNextPageError, isPlaceholderData } = result;
	const rows = useMemo(() => (data ? joinPages(data.pages) : NO_ROWS), [data]);
	const first = data?.pages[0];
	// Placeholder rows are the PREVIOUS filter's: their next cursor belongs to that walk, so no
	// "Load more" is offered until the new filter's first page has landed.
	const hasMore = result.hasNextPage && !isPlaceholderData;

	const loadMore = useCallback(() => {
		if (isFetchingNextPage || !hasMore) return;
		void fetchNextPage();
	}, [fetchNextPage, hasMore, isFetchingNextPage]);

	return {
		rows,
		facets: first?.facets ?? null,
		universeEmpty: first?.universeEmpty ?? null,
		query: {
			isLoading: result.isLoading,
			// A later page's failure is the footer's to tell; the rows above it are not stale.
			isError: result.isError && !isFetchNextPageError,
			data,
			error: result.error,
			refetch,
		},
		isPending: result.isPending,
		isPlaceholderData,
		hasMore,
		loadingMore: isFetchingNextPage,
		loadMoreFailed: isFetchNextPageError,
		loadMore,
	};
}
