"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Jobs list — the console filter standard (#578): zustand store + URL sync, server-side
// filtering + facet counts (`jobs.page`), the normalized query in the TanStack key, and
// keepPreviousData dimming instead of client-side .filter() over the whole cache. Paged by the
// list standard's keyset contract (#7483): `useKeysetList` + `<DataTable keyset>` + its
// `ListFooter`, so every job in the scope is reachable by scrolling, and no count is shown.
//
// LIVE. A job that changes is a `jobs` hint on the org's change stream, which invalidates
// `orpc.jobs.page.key()` — a prefix of this list's infinite key (lib/query/topics.ts). TanStack then
// re-reads the loaded pages in order from page one, each with the cursor the page before it now
// ends on, so a job inserted at the top shifts the boundaries instead of breaking them; the join
// keeps each job id once (`useKeysetList`), so a job seen on two pages mid-refetch is drawn once.

import { DataTable } from "@/components/data-table";
import { RegionError } from "@repo/ui/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { buildJobColumns, jobHref } from "@/components/jobs/columns";
import type { JobAuthorInfo } from "@/components/jobs/job-author";
import { JobsRangeControls, jobsToolbarFacets } from "@/components/jobs/jobs-facets";
import { DEFAULT_JOBS_FILTERS, jobsRangeWindow, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { ARCHITECTURE } from "@/lib/copy/vocabulary";
import { displayName } from "@/lib/user-display";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useMembersQuery } from "@/lib/query/use-activity-query";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { orpc } from "@/lib/rpc/client";
import { projectHref } from "@/lib/routing";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useJobsFilters } from "@/lib/stores/use-jobs-filters";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { FilterEmpty } from "@repo/ui/filter-bar";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { TooltipProvider } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

/**
 * Jobs list UI. Filters live in the jobs filter store (URL-synced, the date range included); rows
 * and facet counts come from `jobs.page` (server-side filtering — the standard), one keyset page at
 * a time.
 *
 * Pass `projectId` for a project's own list. The project is then the list's SCOPE, not a filter:
 * the read counts its facets inside that project, the Project facet and column are dropped, and a
 * project with no jobs gets its own first-run state.
 */
export function JobsClient({ projectId }: { projectId?: string } = {}) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { project: projectSlug } = useParams<{ project?: string }>();

	// The console filter standard: store + URL sync. Every filter is in the store, so the link
	// carries the whole view and one reset clears all of it.
	const filters = useJobsFilters((s) => s.filters);
	const set = useJobsFilters((s) => s.set);
	const reset = useJobsFilters((s) => s.reset);
	const { inputRef, shortcut } = useListSearchShortcut();
	const urlRead = useFilterUrlSync(useJobsFilters, DEFAULT_JOBS_FILTERS);
	// Search stays responsive (bound to filters.search) but only re-keys the query after a
	// 300ms pause — the input recomputes the memo on every keystroke, yet the normalized
	// object (and so the structural TanStack key) is stable until the debounced value moves.
	const debouncedSearch = useDebouncedValue(filters.search, 300, { urlRead });

	// The window the range controls SHOW. A preset is resolved against one instant taken at mount:
	// resolved per render its `to` would move every time. The READ resolves the preset itself.
	const [mountedAt] = useState(() => new Date());
	const range = useMemo(() => jobsRangeWindow(filters.range, mountedAt), [filters.range, mountedAt]);

	// The normalized query IS the key: equal filters hit the cache, and the route's server component
	// builds the same object from the same link, so first paint is the prefetched answer. A change of
	// filters is a new key, so the walk restarts at page one; the cursor is the infinite query's page
	// param and never part of this object.
	const view = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
	const input = useMemo(() => normalizeJobsQuery(view, projectId), [view, projectId]);
	const list = useKeysetList(orpc.jobs.page, input);
	const rows = list.rows;
	const facets = list.facets ?? undefined;

	// Author names resolve through the cached members query (the facet carries ids); counts come
	// from the unfiltered facet universe.
	const { data: members = [] } = useMembersQuery();
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
	/** An author id's display name, or the id until the members have loaded. */
	const authorLabel = (userId: string): string => {
		const m = memberById.get(userId);
		return m ? displayName({ name: m.name, username: m.username, email: m.email }) : userId;
	};

	const columns = useMemo(
		() => buildJobColumns({ showProject: !projectId, authorById, orgSlug }),
		[projectId, authorById, orgSlug],
	);

	// A plain click anywhere on a row opens the job; the row's Type cell is the job's real link
	// (`buildJobColumns`), which is what a cmd-, ctrl- or middle-click and "copy link" act on.
	const handleRowClick = (job: { id: string }) => {
		router.push(jobHref(orgSlug, job.id));
	};

	// `universeEmpty` is the facet pass's answer about the SCOPE — the org, or this project —
	// whatever the filters: true means the scope has no jobs at all (first run). Jobs that exist but
	// are all excluded by the filters are a distinct "no match" state — never the same copy as first
	// run. Both are read only once the first page has landed.
	const firstRun = !list.isPending && list.universeEmpty === true;
	const noMatch = !list.isPending && list.universeEmpty === false && rows.length === 0;
	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the runners list's rule
	// (#4980). Before the first answer this page renders the bar over an EMPTY table with no count,
	// which reads exactly like a project with no jobs; `aria-busy` is what tells the two apart, for
	// assistive tech and for the audit's F8–F9 read, which scored `/[org]/[project]/jobs` as a
	// zero-row list while its fetch was still queued (#5045).
	const busy = !urlRead || list.isPending || list.isPlaceholderData || filters.search !== debouncedSearch;

	// A refusal is not a failure and neither is an empty list (RUBRIC B4). Only a read with nothing
	// to show reaches these: a failed REFRESH behind rows already on screen is the table's own
	// stale notice, and a failed LATER page is the footer's retry line (`DataTable` `keyset`).
	const firstPageFailed = list.query.isError && list.query.data === undefined;
	const refusal = firstPageFailed ? readRefusalOf(list.query.error) : null;
	const failed = firstPageFailed && refusal === null;

	return (
		<div className="space-y-6" aria-busy={busy}>
			{refusal ? (
				<RegionRefusal className="min-h-[60vh]" refusal={refusal} subject="jobs" />
			) : failed ? (
				// A failed read must NOT fall through to the empty state — that would tell the user
				// they have no jobs when the request failed.
				<RegionError
					className="min-h-[60vh]"
					title="Couldn't load jobs"
					description="Something went wrong fetching your jobs. Check your connection and try again."
					onRetry={() => void list.query.refetch()}
				/>
			) : firstRun ? (
				projectId ? (
					<EmptyState
						className="min-h-[60vh]"
						data-state="first-run"
						icon={<ClipboardList />}
						level={2}
						title="No jobs for this project yet"
						description={`A job is one run of a plan, a deploy or a destroy. Plan or deploy this project from its ${ARCHITECTURE} and the run appears here.`}
						action={
							projectSlug ? (
								<Button
									variant="outline"
									size="sm"
									nativeButton={false}
									render={<Link href={projectHref(orgSlug, projectSlug)} />}
								>
									Open {ARCHITECTURE}
								</Button>
							) : undefined
						}
					/>
				) : (
					<EmptyState
						className="min-h-[60vh]"
						data-state="first-run"
						icon={<ClipboardList />}
						level={2}
						title="No jobs yet"
						description="A job is one run of a plan, a deploy or a destroy. Your first appears here when you plan or deploy a project."
						action={
							<Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/new`} />}>
								Create a project
							</Button>
						}
					/>
				)
			) : (
				<>
					{/* One row: search, facets, range, Reset · N. No count (lib/query/README.md →
					    "Counts") and no description line (polish-wave spec §3). */}
					<ListToolbar
						search={{
							value: filters.search,
							onChange: (v) => set("search", v),
							placeholder: "Filter by project, environment, or error…",
							ariaLabel: "Search jobs",
							inputRef,
							shortcut,
						}}
						facets={jobsToolbarFacets({ filters, set, facets, authorLabel, showProject: !projectId })}
						dateRange={<JobsRangeControls filters={filters} set={set} range={range} />}
						reset={{ count: countActiveFilters(filters, DEFAULT_JOBS_FILTERS), onReset: reset }}
					/>

					{noMatch ? (
						<FilterEmpty className="min-h-[50vh]" level={2} noun="jobs" onClear={reset} />
					) : (
						<TooltipProvider delayDuration={300}>
							{/* keepPreviousData: the previous filters' rows stay visible, dimmed, while
							    a filter change fetches its first page (the standard's
							    isPlaceholderData rule). No fixed-height scroll frame: the footer's
							    scroll sentinel watches the viewport, so the table must grow with the
							    page for "scrolled to the end" to mean the end of the rows. */}
							<div className={cn("transition-opacity", list.isPlaceholderData && "opacity-60")}>
								<DataTable columns={columns} keyset={list} onRowClick={handleRowClick} />
							</div>
						</TooltipProvider>
					)}
				</>
			)}
		</div>
	);
}
