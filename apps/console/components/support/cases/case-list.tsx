"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { cn } from "@repo/ui/utils";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { LifeBuoy, Loader2, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import {
	CASE_LIST_PARAM_NAMES,
	caseFacetOptions,
	DEFAULT_SUPPORT_CASE_FILTERS,
	matchesSupportCaseQuery,
	normalizeSupportCaseQuery,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "@/lib/query/use-infinite-scroll";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import {
	type CaseCursor,
	type CaseListItem as CaseListItemData,
	nextCaseCursor,
} from "@/lib/queries/support";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useSupportFilters } from "@/lib/stores/use-support-filters";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_SEVERITY_LABELS,
} from "@/lib/validations/support";
import { CaseFilterBar } from "./case-filter-bar";
import { CASE_ROWS, CaseListItem } from "./case-list-item";
import { CaseListSkeletonRows } from "./case-list-skeleton";

/** Stable empty result — see the note at its use site. */
const NO_ROWS: CaseListItemData[] = [];

/** Stable "no further pages loaded" — a fresh `[]` per render would defeat the rows memo. */
const NO_PAGES: CaseListItemData[][] = [];

/**
 * Joins the first page with the pages loaded after it, keeping each case once (its first
 * occurrence). A refetch of page one can lift a case that a later, older page still holds —
 * a reply moves it to the top — and the list must not draw it twice.
 */
function mergeCasePages(
	first: readonly CaseListItemData[],
	more: readonly (readonly CaseListItemData[])[],
): CaseListItemData[] {
	if (more.length === 0) return [...first];
	const seen = new Set<string>();
	const out: CaseListItemData[] = [];
	for (const row of [first, ...more].flat()) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		out.push(row);
	}
	return out;
}

/**
 * The support case list, on the console filter standard (lib/query/README.md →
 * "Server-side filters"): the URL-synced `useSupportFilters` store feeds a debounced,
 * normalized query into the `support.cases` GET read for its bucket, and the search /
 * severity / type refinement runs as a pure predicate over the returned rows (see the
 * header of case-query.ts for why those three are client-side and the bucket is not).
 *
 * Paged by keyset (#7389): `support.cases` answers one page per cursor, newest activity first with
 * the case id breaking ties. Page one keeps the exact key the route prefetches, so it still paints
 * from the server HTML; "Load more" (and the scroll sentinel behind it, as on the Activity log)
 * walks an infinite query seeded with page one's last row. Search, severity and type refine the
 * rows LOADED so far — until the last page is in, the toolbar shows no count rather than a
 * number that would read as the total.
 *
 * Result count lives in the page toolbar's pill, never as prose in the bar. When `seeAll`
 * (the caller holds manage_support) the list is the whole org's cases — the toolbar's line
 * says so and each foreign row shows its opener.
 */
export function CaseList({
	orgSlug,
	seeAll = false,
}: {
	orgSlug: string;
	seeAll?: boolean;
}) {
	const filters = useSupportFilters((s) => s.filters);
	const reset = useSupportFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useSupportFilters, DEFAULT_SUPPORT_CASE_FILTERS, CASE_LIST_PARAM_NAMES);

	// Only the DEBOUNCED search reaches the query, and the memo is keyed on the individual
	// filter fields rather than the `filters` object — that object gets a fresh identity on
	// every keystroke, which would re-derive (and re-filter) the whole list ahead of the
	// debounce it exists to wait for.
	// `urlRead`: a search the link carried (`?search=`) lands at once; only typing is debounced (#5861).
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });
	const query = useMemo(
		() =>
			normalizeSupportCaseQuery({
				bucket: filters.bucket,
				search: debouncedSearch,
				severity: filters.severity,
				type: filters.type,
			}),
		[filters.bucket, filters.severity, filters.type, debouncedSearch],
	);

	// The route prefetched this key (`my-cases/page.tsx`), so the rows are in the server HTML and
	// the hydrating render draws the same rows: no client fetch on mount, no pending flash. (This
	// used to render pending until hydration was over, because the bell shared the key; the bell
	// reads its own feed now, `workspace.supportCases`, so nothing else fills this entry early.)
	const result = useQuery(
		orpc.support.cases.queryOptions({
			input: { bucket: query.bucket },
			placeholderData: keepPreviousData,
		}),
	);
	const { refetch, isPending, isPlaceholderData } = result;
	const isError = result.isError && result.data === undefined;
	// A refused read answers the same every time: it is told as a refusal, with no retry (G-16).
	const refusal = isError ? readRefusalOf(result.error) : null;
	// A module-level empty array, not an inline `= []` default: a fresh literal on every
	// render would give the memos below a new dependency identity each time and defeat them.
	const firstPage = result.data ?? NO_ROWS;

	// The pages after the first. Keyed (through oRPC's infinite key) on page one's last row, so a
	// refetched page one restarts the walk from wherever page one now ends (the previous pages stay
	// on screen until it lands, and `mergeCasePages` drops any case both hold). Disabled until the
	// reader asks for more in THIS bucket — nothing is fetched speculatively.
	const firstCursor = isPlaceholderData ? null : nextCaseCursor(firstPage);
	const [extendBucket, setExtendBucket] = useState<string | null>(null);
	const extending = firstCursor !== null && extendBucket === query.bucket;
	const more = useInfiniteQuery(
		orpc.support.cases.infiniteOptions({
			input: (cursor: CaseCursor | null) => ({
				bucket: query.bucket,
				cursor: cursor ?? undefined,
			}),
			initialPageParam: firstCursor,
			getNextPageParam: (last: CaseListItemData[]) => nextCaseCursor(last),
			enabled: extending,
			placeholderData: keepPreviousData,
		}),
	);
	const { fetchNextPage } = more;
	const morePages = extending ? (more.data?.pages ?? NO_PAGES) : NO_PAGES;
	const rows = useMemo(() => mergeCasePages(firstPage, morePages), [firstPage, morePages]);
	const hasMore = extending ? more.hasNextPage || more.isPending : firstCursor !== null;
	const loadingMore = extending && (more.isPending || more.isFetchingNextPage);
	// A failed page means the end is unknown, exactly as an unloaded one does.
	const totalKnown = !hasMore && !(extending && more.isError);

	/** Load the next page: the first click starts the walk after page one, later ones extend it. */
	const onLoadMore = () => {
		if (loadingMore || !hasMore) return;
		if (!extending) setExtendBucket(query.bucket);
		else void fetchNextPage();
	};
	const sentinelRef = useInfiniteScrollSentinel({
		hasMore,
		loading: loadingMore,
		onLoadMore,
		resetKey: rows.length,
	});

	// Facet counts come off the bucket's rows BEFORE the client-side refinement, so an
	// option never disappears at the moment you select it.
	const severityOptions = useMemo(
		() => caseFacetOptions(rows, "severity", SUPPORT_SEVERITY_LABELS),
		[rows],
	);
	const typeOptions = useMemo(
		() => caseFacetOptions(rows, "type", SUPPORT_CASE_TYPE_LABELS),
		[rows],
	);

	const visible = useMemo(
		() => rows.filter((row) => matchesSupportCaseQuery(row, query)),
		[rows, query],
	);

	const activeFilters = countActiveFilters<SupportCaseFilters>(
		filters,
		DEFAULT_SUPPORT_CASE_FILTERS,
	);

	return (
		<div className="space-y-4">
			<PageToolbar
				description={
					seeAll
						? "Every support case in this organization."
						: "Your support cases and their conversation threads."
				}
				count={isPending || !totalKnown ? null : visible.length}
				actions={
					<Button
						size="sm"
						nativeButton={false}
						render={<Link href={`/${orgSlug}/~/support/submit`} />}
					>
						Submit a case
					</Button>
				}
			/>

			<CaseFilterBar
				severityOptions={severityOptions}
				typeOptions={typeOptions}
			/>

			{isPending ? (
				// Pending is not empty (B3): rows-shaped placeholders, never "No cases yet".
				<CaseListSkeletonRows />
			) : refusal ? (
				<RegionRefusal refusal={refusal} subject="these support cases" />
			) : isError ? (
				// A fetch failure must not render as "no cases yet".
				<RegionError
					title={seeAll ? "Couldn't load the cases" : "Couldn't load your cases"}
					description="Something went wrong fetching the support cases. Try again in a moment."
					onRetry={() => refetch()}
				/>
			) : visible.length === 0 && !hasMore ? (
				// Two different empties: nothing to show at all, versus nothing that
				// survived the filters — conflating them is how a filtered list comes to
				// look broken.
				activeFilters > 0 ? (
					<Empty className="rounded-md border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SearchX />
							</EmptyMedia>
							<EmptyTitle>No cases match these filters</EmptyTitle>
							<EmptyDescription>
								Nothing in this view matches what you&apos;ve selected.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button variant="outline" size="sm" onClick={reset}>
								Reset filters
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Empty className="rounded-md border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LifeBuoy />
							</EmptyMedia>
							<EmptyTitle>No cases yet</EmptyTitle>
							<EmptyDescription>
								When you open a support case it will appear here.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								size="sm"
								nativeButton={false}
								render={<Link href={`/${orgSlug}/~/support/submit`} />}
							>
								Submit a case
							</Button>
						</EmptyContent>
					</Empty>
				)
			) : (
				// A real list (`ul`/`li`): it is one, and it is how the page says its bottom edge is
				// open-ended — a skeleton cannot know how many cases there are (#6354, B2).
				<>
					{visible.length > 0 ? (
						<ul className={cn(CASE_ROWS, isPlaceholderData && "opacity-60")}>
							{visible.map((item) => (
								<li key={item.id}>
									<CaseListItem item={item} orgSlug={orgSlug} />
								</li>
							))}
						</ul>
					) : (
						// Nothing loaded so far survives the filters, but more cases exist: say so
						// beside the control that reaches them, instead of an empty state that would
						// claim there is nothing.
						<p className="text-ui-sm text-text-secondary">
							None of the cases loaded so far match these filters.
						</p>
					)}
					{extending && more.isError ? (
						// A failed "Load more" is said under the rows it would have extended; it never
						// replaces them (the Activity log's R6 E-26 rule).
						<p role="status" className="flex items-center justify-center gap-2 text-ui-sm text-text-secondary">
							Couldn&apos;t load more cases.
							<Button
								variant="outline"
								size="sm"
								onClick={() => void (more.data ? more.fetchNextPage() : more.refetch())}
							>
								Try again
							</Button>
						</p>
					) : hasMore ? (
						<div className="flex justify-center pt-1">
							{/* Invisible tail sentinel that drives the auto-load-on-scroll. */}
							<div ref={sentinelRef} aria-hidden className="h-px w-px" />
							<Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
								{loadingMore && <Loader2 className="size-3.5 animate-spin" />}
								Load more
							</Button>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}
