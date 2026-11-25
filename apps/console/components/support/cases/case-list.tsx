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
import { LifeBuoy, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { ListFooter } from "@/components/list/list-footer";
import {
	CASE_LIST_PARAM_NAMES,
	caseFacetOptions,
	DEFAULT_SUPPORT_CASE_FILTERS,
	normalizeSupportCaseQuery,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSupportFilters } from "@/lib/stores/use-support-filters";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_SEVERITY_LABELS,
} from "@/lib/validations/support";
import { CaseFilterBar } from "./case-filter-bar";
import { CASE_ROWS, CaseListItem } from "./case-list-item";
import { CaseListSkeletonRows } from "./case-list-skeleton";

/**
 * The support case list, on the console filter standard (lib/query/README.md →
 * "Server-side filters"): the URL-synced `useSupportFilters` store feeds a debounced,
 * normalized query — bucket, search, severity, type — into the `support.cases` GET read, which
 * applies every one of them in SQL and returns the facet counts over the caller's unfiltered cases
 * on its first page (#7396).
 *
 * Paged on the console list contract (lib/query/README.md → "Paging"; #7494): `support.cases`
 * answers one keyset page per opaque cursor, newest activity first with the case id breaking ties,
 * read through `useKeysetList` — whose first page is the exact key the route prefetches, so it
 * still paints from the server HTML — and footed by `ListFooter` (the scroll sentinel plus the
 * always-visible "Load more", and the retry line on a failed page with the rows kept).
 *
 * No count anywhere: the console carries no list counts (README → "Counts"). When `seeAll`
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

	// The route prefetched this key's first page (`my-cases/page.tsx`), so the rows are in the
	// server HTML and the hydrating render draws the same rows: no client fetch on mount, no pending
	// flash. (The bell reads its own feed, `workspace.supportCases`, so nothing else fills this entry.)
	const list = useKeysetList(orpc.support.cases, query);
	const { rows, facets, isPending, isPlaceholderData } = list;
	const isError = list.query.isError && list.query.data === undefined;
	// A refused read answers the same every time: it is told as a refusal, with no retry (G-16).
	const refusal = isError ? readRefusalOf(list.query.error) : null;

	// Facet counts come from the server's facet pass over the caller's UNFILTERED cases, so an
	// option never disappears at the moment you select it.
	const severityOptions = useMemo(
		() => caseFacetOptions(facets?.severity, SUPPORT_SEVERITY_LABELS),
		[facets],
	);
	const typeOptions = useMemo(
		() => caseFacetOptions(facets?.type, SUPPORT_CASE_TYPE_LABELS),
		[facets],
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
					onRetry={() => list.query.refetch()}
				/>
			) : rows.length === 0 ? (
				// Two different empties: nothing to show at all, versus nothing that
				// survived the filters — conflating them is how a filtered list comes to
				// look broken. `universeEmpty` is the server's answer (no case in scope at all),
				// so a filtered link into an org with no cases still offers "Submit a case".
				activeFilters > 0 && list.universeEmpty !== true ? (
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
					{/* `aria-busy` while the rows are the PREVIOUS filter's placeholder (the keyset
					    list's `keepPreviousData`): dimmed for the eye, declared for assistive tech and
					    for the filter audit's settle (#7673). */}
					<ul className={cn(CASE_ROWS, isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData || undefined}>
						{rows.map((item) => (
							// The list-item marker (#7673, components/data-table.tsx).
							<li key={item.id} data-list-item="">
								<CaseListItem item={item} orgSlug={orgSlug} />
							</li>
						))}
					</ul>
					<ListFooter list={list} />
				</>
			)}
		</div>
	);
}
