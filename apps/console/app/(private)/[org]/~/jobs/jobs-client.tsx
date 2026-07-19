"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Jobs list — the console filter standard (#578): zustand store + URL sync, server-side
// filtering + facet counts (getJobsPage), the normalized query in the TanStack key, and
// keepPreviousData dimming instead of client-side .filter() over the whole cache.

import { lookup } from "@/lib/typed-object";
import { DataTable } from "@/components/data-table";
import { ErrorState } from "@/components/errors/error-state";
import { buildJobColumns } from "@/components/jobs/columns";
import type { JobAuthorInfo } from "@/components/jobs/job-author";
import {
	DEFAULT_JOBS_FILTERS,
	normalizeJobsQuery,
} from "@/components/jobs/jobs-query";
import { JOB_TYPES } from "@/lib/jobs/format";
import { displayName } from "@/lib/user-display";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useMembersQuery } from "@/lib/query/use-activity-query";
import { useJobsPageQuery } from "@/lib/query/use-jobs-page-query";
import { useJobsFilters } from "@/lib/stores/use-jobs-filters";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import type { JobsFacetOption, JobWithMeta } from "@/app/server/actions/jobs";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { TooltipProvider } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import {
	Activity,
	Boxes,
	ClipboardList,
	Layers,
	SearchX,
	Users,
	Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

/** Jobs default to a wide window so history isn't hidden; users narrow with the range picker. */
const JOBS_DEFAULT_PRESET = "12mo";

const STATUS_LABELS = new Map(
	["QUEUED", "CLAIMED", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED"].map((s) => [
		s,
		s.charAt(0) + s.slice(1).toLowerCase(),
	]),
);

/** Facet options → MultiCombobox options: label fallback + the count as the hint. */
function comboOptions(
	facet: JobsFacetOption[] | undefined,
	label: (o: JobsFacetOption) => string = (o) => o.label ?? o.value,
) {
	return (facet ?? []).map((o) => ({
		value: o.value,
		label: label(o),
		hint: String(o.count),
	}));
}

/**
 * Jobs list UI. Filters live in the jobs filter store (URL-synced); rows + facet counts
 * come from the parameterized `getJobsPage` (server-side filtering — the standard). Pass
 * `projectId` to scope it to one project (the Project facet + column are then hidden) —
 * used by a project's jobs tab; the org route passes none.
 */
export function JobsClient({ projectId }: { projectId?: string } = {}) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();

	// The console filter standard: store + URL sync. The date range stays local — its
	// presets are now-relative, so persisting a resolved range would go stale (see
	// components/jobs/jobs-query.ts).
	const filters = useJobsFilters((s) => s.filters);
	const set = useJobsFilters((s) => s.set);
	const reset = useJobsFilters((s) => s.reset);
	useFilterUrlSync(useJobsFilters, DEFAULT_JOBS_FILTERS);
	const [range, setRange] = useState<DateRange>(() =>
		presetRange(JOBS_DEFAULT_PRESET),
	);
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === JOBS_DEFAULT_PRESET)?.label ??
			"Last 12 months",
	);
	// "Show more" window — grows client-side over the already server-filtered rows (like the
	// Activity log), instead of page-number pagination.
	const [visibleCount, setVisibleCount] = useState(20);

	// Search stays responsive (bound to filters.search) but only re-keys the query after a
	// 300ms pause — the input recomputes the memo on every keystroke, yet the normalized
	// object (and so the structural TanStack key) is stable until the debounced value moves.
	const debouncedSearch = useDebouncedValue(filters.search, 300);

	// The normalized query IS the key: equal filters hit the cache, and the range's
	// concrete ISO bounds only change when the user picks a range.
	const query = useMemo(
		() =>
			normalizeJobsQuery(
				{ ...filters, search: debouncedSearch },
				{ from: range.from.toISOString(), to: range.to.toISOString() },
				projectId,
			),
		[filters, debouncedSearch, range, projectId],
	);
	const page = useJobsPageQuery(query);
	const rows = useMemo(() => page.data?.rows ?? [], [page.data]);
	const facets = page.data?.facets;

	// Author labels/avatars resolve through the cached members query; counts come from
	// the unfiltered facet universe.
	const { data: members = [], isPending: membersLoading } = useMembersQuery();
	const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
	const authorById = useMemo(
		() =>
			new Map<string, JobAuthorInfo>(
				members.map((m) => [
					m.userId,
					{ name: m.name, username: m.username, email: m.email, image: m.image },
				]),
			),
		[members],
	);
	const userOptions = useMemo(
		() =>
			(facets?.authors ?? []).map((o) => {
				const m = memberById.get(o.value);
				return {
					value: o.value,
					label: m
						? displayName({ name: m.name, username: m.username, email: m.email })
						: o.value,
					image: m?.image,
					hint: String(o.count),
				};
			}),
		[facets, memberById],
	);

	// Reset the visible window whenever the filters change (the set may shrink).
	useEffect(() => {
		setVisibleCount(20);
	}, [query]);

	const columns = useMemo(
		() => buildJobColumns({ showProject: !projectId, authorById, orgSlug }),
		[projectId, authorById, orgSlug],
	);

	const handleRowClick = (job: JobWithMeta) => {
		router.push(`/${orgSlug}/~/jobs/${job.id}`);
	};

	// `total` is the count over the UNFILTERED universe, so total === 0 means the org has
	// no jobs at all (onboarding). When jobs exist but the current filters exclude every
	// row, that's a distinct "no match" state — never the same copy as onboarding.
	const total = page.data?.total ?? 0;
	const noMatch = !page.isPending && total > 0 && rows.length === 0;

	/** Reset every filter surface — the store filters AND the local date range. */
	const clearAll = () => {
		reset();
		setRange(presetRange(JOBS_DEFAULT_PRESET));
		setRangeLabel(
			RANGE_PRESETS.find((p) => p.id === JOBS_DEFAULT_PRESET)?.label ??
				"Last 12 months",
		);
	};

	return (
		<div className="space-y-6">
			{page.isError ? (
					// A fetch failure must NOT fall through to the empty state — that would tell the
					// user they have no jobs when the request actually failed.
					<ErrorState
						title="Couldn't load jobs"
						description="Something went wrong fetching your jobs. Check your connection and try again."
						actions={
							<Button variant="outline" size="sm" onClick={() => page.refetch()}>
								Retry
							</Button>
						}
					/>
				) : !page.isPending && total === 0 ? (
				<Empty className="min-h-[60vh]">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ClipboardList />
						</EmptyMedia>
						<EmptyTitle>No jobs yet</EmptyTitle>
						<EmptyDescription>
							Jobs are created when you provision a project or connect a cloud
							account.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button asChild variant="outline" size="sm">
							<Link href={`/${orgSlug}/~/new`}>Create a project</Link>
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<FilterBar
						end={
							<FilterBarReset
								count={countActiveFilters(filters, DEFAULT_JOBS_FILTERS)}
								onReset={reset}
							/>
						}
					>
						<FilterSearch
							value={filters.search}
							onChange={(v) => set("search", v)}
							placeholder="Filter by project, environment, or error…"
							ariaLabel="Search jobs"
							className="w-[220px] max-w-[340px] flex-1"
						/>
						<QuickRangeFilter
							label={rangeLabel}
							value={range}
							onChange={(r, l) => {
								setRange(r);
								if (l !== undefined) setRangeLabel(l);
							}}
						/>
						<DateRangeFilter
							value={range}
							onChange={(r) => {
								setRange(r);
								setRangeLabel(formatRangeLabel(r));
							}}
						/>
						<MultiCombobox
							placeholder="All authors"
							icon={Users}
							options={userOptions}
							value={filters.authors}
							onChange={(next) => set("authors", next)}
							withAvatar
							loading={membersLoading}
						/>
						<MultiCombobox
							placeholder="All environments"
							icon={Layers}
							options={comboOptions(facets?.envs)}
							value={filters.envs}
							onChange={(next) => set("envs", next)}
						/>
						{!projectId && (
							<MultiCombobox
								placeholder="All projects"
								icon={Boxes}
								options={comboOptions(facets?.projects)}
								value={filters.projects}
								onChange={(next) => set("projects", next)}
								emptyAction={{
									label: "Create project",
									onSelect: () => router.push(`/${orgSlug}/~/new`),
								}}
							/>
						)}
						<MultiCombobox
							placeholder="All statuses"
							icon={Activity}
							options={comboOptions(
								facets?.statuses,
								(o) => STATUS_LABELS.get(o.value) ?? o.value,
							)}
							value={filters.statuses}
							onChange={(next) => set("statuses", next)}
						/>
						<MultiCombobox
							placeholder="All types"
							icon={Wrench}
							options={comboOptions(
								facets?.types,
								(o) => lookup(JOB_TYPES, o.value)?.label ?? o.value,
							)}
							value={filters.types}
							onChange={(next) => set("types", next)}
						/>
					</FilterBar>

					{noMatch ? (
						<Empty className="min-h-[50vh]">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<SearchX />
								</EmptyMedia>
								<EmptyTitle>No jobs match these filters</EmptyTitle>
								<EmptyDescription>
									Every job is excluded by the current range, author, environment,
									status, or type selection.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button variant="outline" size="sm" onClick={clearAll}>
									Clear filters
								</Button>
							</EmptyContent>
						</Empty>
					) : (
						<TooltipProvider delayDuration={300}>
							{/* keepPreviousData: the previous rows stay visible, dimmed, while a
							    filter change refetches (the standard's isPlaceholderData rule). */}
							<div
								className={cn(
									"transition-opacity",
									page.isPlaceholderData && "opacity-60",
								)}
							>
								<DataTable
									columns={columns}
									data={rows}
									onRowClick={handleRowClick}
									pageSize={visibleCount}
									loadMore={{
										hasMore: rows.length > visibleCount,
										onLoadMore: () => setVisibleCount((c) => c + 20),
									}}
									scrollHeight="h-[70vh]"
								/>
							</div>
						</TooltipProvider>
					)}
				</>
			)}
		</div>
	);
}
