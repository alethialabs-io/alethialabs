"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet / Runners page. A two-column layout (mirrors the org overview): the left column
// stacks the warm Pools and the Versions changelog; the right column is the filterable,
// paginated grid of runner cards. No eyebrow/title/KPI chrome — pools and runners show first.

import { lookup } from "@/lib/typed-object";
import { EmptyState } from "@repo/ui/empty";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { RegionError } from "@/components/errors/region-error";
import { isForbidden } from "@/components/overview/overview-reads";
import { PoolsSection } from "@/components/runners/pools-section";
import { RunnerCard, RunnerCardSkeleton } from "@/components/runners/runner-card";
import {
	RunnersToolbar,
	type RunnerFacetOption,
} from "@/components/runners/runners-toolbar";
import { RunnersPager } from "@/components/runners/runners-pager";
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
import { ANY_CLOUD } from "@/lib/queries/runners";
import { useRunnersPageQuery } from "@/lib/query/use-runners-page-query";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 9;

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
	const urlRead = useFilterUrlSync(useRunnerFilters, DEFAULT_RUNNER_FILTERS);
	// Seeded from the URL, so a pasted `?search=…&versions=…` asks for the key the route
	// prefetched first — not `{versions}` alone, which it did not (#4980 review).
	const search = useDebouncedValue(filters.search, 300, { urlRead });
	const query = useMemo(
		() => normalizeRunnersQuery(filters, search),
		[filters, search],
	);
	const {
		data: runnersPage,
		isPending: isLoading,
		isError,
		error,
		isPlaceholderData,
		refetch,
	} = useRunnersPageQuery(query);
	const [page, setPage] = useState(1);
	// The grid is BUSY while what it shows may not answer the URL and the bar: before the link
	// has been read into the store, before the first answer, while the rows are the previous
	// query's placeholder, and while a typed search is still inside its debounce. Exposed as
	// `aria-busy` on the column, so assistive tech — and the audit's F8 read, which used to accept
	// a placeholder as an answer (#4980) — can tell an answer from a stand-in. The dim below is
	// the placeholder half only: dimming the first paint of every visit would flash a page that
	// is correct.
	const busy = !urlRead || isLoading || isPlaceholderData || filters.search !== search;

	// Reset to the first page whenever the result set changes shape.
	useEffect(() => {
		setPage(1);
	}, [query]);

	// The SERVER's rows, each with the job in flight on it (joined on the server, #6123).
	const filtered = useMemo(() => runnersPage?.rows ?? [], [runnersPage]);
	/** Every runner the actor can see — "no runners yet", as opposed to "none match". */
	const total = runnersPage?.total ?? 0;

	// Facet options from the builder's own pass over the UNFILTERED universe. Only the labels
	// are resolved here: the server counts values, and what a provider or a version is CALLED
	// is a client constant.
	const facets = useMemo(() => {
		const clouds: CloudFilterOption[] = (runnersPage?.facets.clouds ?? []).map((o) => ({
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
			regions: plain(runnersPage?.facets.regions ?? [], (v) => v),
			versions: plain(runnersPage?.facets.versions ?? [], (v) => `v${v}`),
		};
	}, [runnersPage]);

	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount);
	const pageItems = useMemo(
		() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
		[filtered, safePage],
	);

	// One batched query hydrates the visible runner cards' classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"runner",
		pageItems.map((r) => r.id),
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
				{/* The section heading and its result count come from the shared primitives. Both
				    were hand-rolled here — a `font-display text-ui-lg` span for the heading and a
				    bordered `rounded-full` span for the pill, the latter under a comment claiming
				    it WAS "the count pill (the standard)". A second copy of a primitive is how two
				    list pages come to disagree about what a count looks like. */}
				<SectionHeading
					title="Runners"
					count={isLoading ? null : (runnersPage?.resultCount ?? 0)}
					actions={<AddRunnerButton />}
				/>

				<RunnersToolbar
					cloudOptions={facets.clouds}
					regionOptions={facets.regions}
					versionOptions={facets.versions}
				/>

				{isError && isForbidden(error) ? (
					// An expected refusal is its own render: retrying it would answer the same (RUBRIC B4).
					<EmptyState
						icon={<Server />}
						title="You don't have access to runners"
						description="Your role in this workspace doesn't include viewing runners. Ask an admin for access."
						className="py-12"
					/>
				) : isError ? (
					// A fetch failure must not render as "no runners".
					<RegionError
						title="Couldn't load runners"
						description="Something went wrong fetching your runners. Check your connection and try again."
						onRetry={() => refetch()}
					/>
				) : isLoading ? (
					<div className={RUNNERS_GRID}>
						{[1, 2, 3, 4].map((i) => (
							<RunnerCardSkeleton key={i} />
						))}
					</div>
				) : total === 0 ? (
					<EmptyRunners />
				) : filtered.length === 0 ? (
					<EmptyState title="No runners match your filters." className="py-12" />
				) : (
					/* The filter standard's `isPlaceholderData` dim: these cards are the PREVIOUS
					   query's answer, kept so the grid does not blank on a filter change and
					   marked so they are not read as the current one. */
					<div className={cn(isPlaceholderData && "opacity-60 transition-opacity")}>
						<div className={RUNNERS_GRID}>
							{pageItems.map((runner) => (
								<RunnerCard
									key={runner.id}
									runner={runner}
									initialAssignments={classMap[runner.id]}
								/>
							))}
						</div>
						<RunnersPager
							page={safePage}
							pageCount={pageCount}
							total={filtered.length}
							onPageChange={setPage}
						/>
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
