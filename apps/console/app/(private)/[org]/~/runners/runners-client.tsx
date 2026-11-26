"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet / Runners page. A two-column layout (mirrors the org overview): the left column
// stacks the warm Pools and the Versions changelog; the right column is the filterable grid of
// runner cards. No eyebrow/title/KPI chrome — pools and runners show first.
//
// PAGING (#7484). The grid reads one keyset page at a time through `useKeysetList` and ends in
// `ListFooter` (a scroll sentinel plus an always-visible "Load more"). The server composes the
// universe — the org's own runners and the managed fleet — filters it and cuts the page
// (`queryRunnersPage`); the browser never holds the whole fleet. No count is shown: the list
// standard carries no list sizes (lib/query/README.md → "Counts").
//
// LIVE (ADR 0005). A runner that changes is a `runners` hint on the org's change stream, which
// invalidates `orpc.runners.page.key()` — a prefix of this list's infinite key (lib/query/topics.ts).
// TanStack re-reads the loaded pages in order from page one, each with the cursor the page before
// it now ends on, and `useKeysetList` keeps each runner id once, so a runner seen on two pages
// mid-refetch is drawn once.

import { lookup } from "@/lib/typed-object";
import { EmptyState } from "@repo/ui/empty";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { isForbidden } from "@/components/overview/overview-reads";
import { PoolsSection } from "@/components/runners/pools-section";
import { RunnerCard, RunnerCardSkeleton } from "@/components/runners/runner-card";
import {
	RunnersToolbar,
	type RunnerFacetOption,
} from "@/components/runners/runners-toolbar";
import { RUNNERS_COLUMNS, RUNNERS_GRID } from "@/components/runners/runners-layout";
import { VersionsPanel } from "@/components/runners/versions-panel";
import type { CloudFilterOption } from "@/components/filters/cloud-filter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import {
	DEFAULT_RUNNER_FILTERS,
	normalizeRunnersQuery,
} from "@/components/runners/runners-query";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";
import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";
import { ListFooter } from "@/components/list/list-footer";
import { StaleRefreshNotice } from "@/components/list/stale-refresh-notice";
import { ANY_CLOUD } from "@/lib/queries/runners";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import { Server } from "lucide-react";
import { useMemo } from "react";

/**
 * The runners page body, rendered only for a viewer the server has already found entitled
 * (`page.tsx` renders the upsell otherwise). `hosted` decides whether the Pools column exists: the
 * managed fleet is never shown to a hosted tenant.
 */
export function RunnersClient({ hosted }: { hosted: boolean }) {
	// The console filter standard (#578), now end to end: zustand store → URL sync → debounced
	// search → normalize → the TanStack key → the SERVER's filtered read. The narrowing and the
	// facet tally used to happen in this component over the whole universe (#4890).
	const filters = useRunnerFilters((s) => s.filters);
	const resetFilters = useRunnerFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useRunnerFilters, DEFAULT_RUNNER_FILTERS);
	// Seeded from the URL, so a pasted `?search=…&versions=…` asks for the key the route
	// prefetched first — not `{versions}` alone, which it did not (#4980 review).
	const search = useDebouncedValue(filters.search, 300, { urlRead });
	const query = useMemo(
		() => normalizeRunnersQuery(filters, search),
		[filters, search],
	);
	// The normalized query IS the key: a filter change is a new key, so the walk restarts at page
	// one; the cursor is the infinite query's page param and never part of this object or the URL.
	const list = useKeysetList(orpc.runners.page, query);
	const rows = list.rows;
	// The grid is BUSY while what it shows may not answer the URL and the bar: before the link
	// has been read into the store, before the first answer, while the rows are the previous
	// query's placeholder, and while a typed search is still inside its debounce. Exposed as
	// `aria-busy` on the column, so assistive tech — and the audit's F8 read, which used to accept
	// a placeholder as an answer (#4980) — can tell an answer from a stand-in. The dim below is
	// the placeholder half only: dimming the first paint of every visit would flash a page that
	// is correct.
	const busy = !urlRead || list.isPending || list.isPlaceholderData || filters.search !== search;
	// A failure with nothing on screen is the region's; a failed REFRESH behind cards already shown
	// keeps them under a one-line notice; a failed LATER page is the footer's retry line.
	const firstPageFailed = list.query.isError && list.query.data === undefined;
	const refused = firstPageFailed && isForbidden(list.query.error);
	const staleRefresh = list.query.isError && list.query.data !== undefined;
	// First page only: true = the actor can see no runner at all (first run), false = some exist,
	// so an empty page is the FILTERED empty state.
	const firstRun = !list.isPending && list.universeEmpty === true;

	// Facet options from the builder's own pass over the UNFILTERED universe, on the first page.
	// Only the labels are resolved here: the server counts values, and what a provider or a version
	// is CALLED is a client constant.
	const facets = useMemo(() => {
		const clouds: CloudFilterOption[] = (list.facets?.clouds ?? []).map((o) => ({
			value: o.value,
			label:
				o.value === ANY_CLOUD
					? "Any"
					: (lookup(PROVIDER_LABELS, o.value) ?? o.value.toUpperCase()),
			count: o.count,
		}));
		const plain = (
			options: { value: string; count: number }[],
			label: (v: string) => string,
		): RunnerFacetOption[] =>
			options.map((o) => ({ value: o.value, label: label(o.value), count: o.count }));
		return {
			clouds,
			regions: plain(list.facets?.regions ?? [], (v) => v),
			versions: plain(list.facets?.versions ?? [], (v) => `v${v}`),
		};
	}, [list.facets]);

	// One batched query hydrates the loaded runner cards' classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"runner",
		rows.map((r) => r.id),
	);

	return (
		<div className={RUNNERS_COLUMNS}>
			{/* Left column — pools (self-managed only), then versions. */}
			<div className="flex flex-col gap-6">
				{!hosted && <PoolsSection />}
				<VersionsPanel />
			</div>

			{/* Right column — runners. */}
			<div className="min-w-0 space-y-4" aria-busy={busy}>
				{/* The section heading comes from the shared primitive, with no count: the list
				    standard carries no list sizes (#7484); totals live only in the facet options. */}
				{refused ? (
					// An expected refusal is its own render, IN PLACE of the column: no
					// "Add runner" and no filter bar over rows this viewer cannot read. Retrying it would
					// answer the same (RUBRIC B4).
					<>
						<SectionHeading title="Runners" />
						<RegionRefusal refusal="forbidden" subject="runners" className="py-12" />
					</>
				) : (
					<>
						<SectionHeading title="Runners" actions={<AddRunnerButton />} />

						<RunnersToolbar
							cloudOptions={facets.clouds}
							regionOptions={facets.regions}
							versionOptions={facets.versions}
						/>
					</>
				)}

				{refused ? null : firstPageFailed ? (
					// A fetch failure must not render as "no runners".
					<RegionError
						title="Couldn't load runners"
						description="Something went wrong fetching your runners. Check your connection and try again."
						onRetry={() => void list.query.refetch()}
					/>
				) : list.isPending ? (
					<div className={RUNNERS_GRID}>
						{[1, 2, 3, 4].map((i) => (
							<RunnerCardSkeleton key={i} />
						))}
					</div>
				) : firstRun ? (
					<EmptyRunners />
				) : rows.length === 0 ? (
					<EmptyState
						title="No runners match your filters."
						description="Change the search or the filters above, or clear them to see every runner."
						action={
							<Button size="sm" variant="outline" onClick={resetFilters}>
								Clear filters
							</Button>
						}
						className="py-12"
					/>
				) : (
					/* The filter standard's `isPlaceholderData` dim: these cards are the PREVIOUS
					   query's answer, kept so the grid does not blank on a filter change and
					   marked so they are not read as the current one. */
					<div className={cn("space-y-4", list.isPlaceholderData && "opacity-60 transition-opacity")}>
						{staleRefresh ? (
							<StaleRefreshNotice slot="runners-stale" onRetry={() => void list.query.refetch()} />
						) : null}
						<div className={RUNNERS_GRID}>
							{rows.map((runner) => (
								<RunnerCard
									key={runner.id}
									runner={runner}
									initialAssignments={classMap[runner.id]}
								/>
							))}
						</div>
						<ListFooter list={list} />
					</div>
				)}
			</div>
		</div>
	);
}

/** First-run state when no runners exist at all. */
function EmptyRunners() {
	return (
		<EmptyState
			icon={<Server />}
			level={3}
			title="No runners yet"
			description="Runners execute provisioning jobs. Managed runners are operated and billed by Alethia; you can also deploy your own into a cloud account or register an existing one."
			action={<AddRunnerButton />}
			className="py-16"
		/>
	);
}
