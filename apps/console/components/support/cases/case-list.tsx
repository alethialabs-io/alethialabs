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
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LifeBuoy, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { RegionError } from "@/components/errors/region-error";
import {
	CASE_LIST_PARAM_NAMES,
	caseFacetOptions,
	DEFAULT_SUPPORT_CASE_FILTERS,
	matchesSupportCaseQuery,
	normalizeSupportCaseQuery,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { CaseListItem as CaseListItemData } from "@/lib/queries/support";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { orpc } from "@/lib/rpc/client";
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

/**
 * The support case list, on the console filter standard (lib/query/README.md →
 * "Server-side filters"): the URL-synced `useSupportFilters` store feeds a debounced,
 * normalized query into the `support.cases` GET read for its bucket, and the search /
 * severity / type refinement runs as a pure predicate over the returned rows (see the
 * header of case-query.ts for why those three are client-side and the bucket is not).
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
	// A module-level empty array, not an inline `= []` default: a fresh literal on every
	// render would give the memos below a new dependency identity each time and defeat them.
	const rows = result.data ?? NO_ROWS;

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
				count={isPending ? null : visible.length}
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
			) : isError ? (
				// A fetch failure must not render as "no cases yet".
				<RegionError
					title="Couldn't load your cases"
					description="Something went wrong fetching your support cases. Check your connection and try again."
					onRetry={() => refetch()}
				/>
			) : visible.length === 0 ? (
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
				<ul className={cn(CASE_ROWS, isPlaceholderData && "opacity-60")}>
					{visible.map((item) => (
						<li key={item.id}>
							<CaseListItem item={item} orgSlug={orgSlug} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
