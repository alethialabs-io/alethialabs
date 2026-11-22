"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Jobs list — the console filter standard (#578): zustand store + URL sync, server-side
// filtering + facet counts (`jobs.page`), the normalized query in the TanStack key, and
// keepPreviousData dimming instead of client-side .filter() over the whole cache.

import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { buildJobColumns, jobHref } from "@/components/jobs/columns";
import type { JobAuthorInfo } from "@/components/jobs/job-author";
import { JobsFilterBar } from "@/components/jobs/jobs-filter-bar";
import {
	DEFAULT_JOBS_FILTERS,
	JOBS_PAGE_MAX,
	JOBS_PAGE_SIZE,
	jobsRangeWindow,
	normalizeJobsQuery,
} from "@/components/jobs/jobs-query";
import { ARCHITECTURE } from "@/lib/copy/vocabulary";
import { displayName } from "@/lib/user-display";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useMembersQuery } from "@/lib/query/use-activity-query";
import { useJobsPageQuery } from "@/lib/query/use-jobs-page-query";
import { projectHref } from "@/lib/routing";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useJobsFilters } from "@/lib/stores/use-jobs-filters";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { TooltipProvider } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { ClipboardList, SearchX } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

/**
 * Jobs list UI. Filters live in the jobs filter store (URL-synced, the date range included); rows,
 * the matched count and facet counts come from `jobs.page` (server-side filtering — the standard).
 *
 * Pass `projectId` for a project's own list. The project is then the list's SCOPE, not a filter:
 * the read counts its facets and its total inside that project, the Project facet and column are
 * dropped, and a project with no jobs gets its own first-run state.
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
	const urlRead = useFilterUrlSync(useJobsFilters, DEFAULT_JOBS_FILTERS);
	// Search stays responsive (bound to filters.search) but only re-keys the query after a
	// 300ms pause — the input recomputes the memo on every keystroke, yet the normalized
	// object (and so the structural TanStack key) is stable until the debounced value moves.
	const debouncedSearch = useDebouncedValue(filters.search, 300, { urlRead });

	// The window the range controls SHOW. A preset is resolved against one instant taken at mount:
	// resolved per render its `to` would move every time. The READ resolves the preset itself.
	const [mountedAt] = useState(() => new Date());
	const range = useMemo(() => jobsRangeWindow(filters.range, mountedAt), [filters.range, mountedAt]);

	// The filters the read is asked, without the row window. It is also what the row window belongs
	// to: a change of filters (the matched set may shrink) starts again at the first window. Keyed
	// by this object rather than reset in an effect, so the first render under new filters already
	// asks for the first window.
	const view = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
	const [grown, setGrown] = useState({ view, limit: JOBS_PAGE_SIZE });
	const limit = grown.view === view ? grown.limit : JOBS_PAGE_SIZE;

	// The normalized query IS the key: equal filters hit the cache, and the route's server component
	// builds the same object from the same link, so first paint is the prefetched answer.
	const input = useMemo(() => normalizeJobsQuery(view, projectId, limit), [view, projectId, limit]);
	const page = useJobsPageQuery(input);
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

	const columns = useMemo(
		() => buildJobColumns({ showProject: !projectId, authorById, orgSlug }),
		[projectId, authorById, orgSlug],
	);

	// A plain click anywhere on a row opens the job; the row's Type cell is the job's real link
	// (`buildJobColumns`), which is what a cmd-, ctrl- or middle-click and "copy link" act on.
	const handleRowClick = (job: { id: string }) => {
		router.push(jobHref(orgSlug, job.id));
	};

	// `total` counts the SCOPE — the org, or this project — whatever the filters, so total === 0
	// means the scope has no jobs at all (first run). `matched` counts what the filters match in
	// it; the rows are its newest window. Jobs that exist but are all excluded by the filters are
	// a distinct "no match" state — never the same copy as first run.
	const total = page.data?.total ?? 0;
	const matched = page.data?.matched ?? 0;
	const noMatch = !page.isPending && total > 0 && rows.length === 0;
	const hasMore = matched > rows.length && rows.length < JOBS_PAGE_MAX;
	const capped = matched > rows.length && rows.length >= JOBS_PAGE_MAX;
	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the runners list's rule
	// (#4980). Before the first answer this page renders the bar over an EMPTY table with no count,
	// which reads exactly like a project with no jobs; `aria-busy` is what tells the two apart, for
	// assistive tech and for the audit's F8–F9 read, which scored `/[org]/[project]/jobs` as a
	// zero-row list while its fetch was still queued (#5045).
	const busy = !urlRead || page.isPending || page.isPlaceholderData || filters.search !== debouncedSearch;

	// A refusal is not a failure and neither is an empty list (RUBRIC B4). Only a read with nothing
	// to show reaches these: a failed REFRESH behind rows already on screen is the table's own
	// stale notice (`DataTable` `query`).
	const refusal = page.isError && page.data === undefined ? readRefusalOf(page.error) : null;
	const failed = page.isError && page.data === undefined && refusal === null;

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
					onRetry={() => void page.refetch()}
				/>
			) : !page.isPending && total === 0 ? (
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
					{/* The result count, through the count pill — the console filter standard's
					    place for it now that the console has no page titles (lib/query/README.md,
					    "Visual grammar"). It counts the jobs the current filters MATCH, of which the
					    table shows the newest window; `total` above is the unfiltered scope and is
					    what tells first run apart from a filter that excludes everything. */}
					<PageToolbar
						description={
							projectId
								? "Every plan, deploy and destroy this project has run."
								: "Every plan, deploy and destroy this organization has run."
						}
						count={page.isPending ? null : matched}
					/>
					<JobsFilterBar
						showProject={!projectId}
						filters={filters}
						onFilter={set}
						onReset={reset}
						range={range}
						authorOptions={userOptions}
						authorsLoading={membersLoading}
						facets={facets}
						onCreateProject={() => router.push(`/${orgSlug}/~/new`)}
					/>

					{noMatch ? (
						<EmptyState
							className="min-h-[50vh]"
							data-state="no-match"
							icon={<SearchX />}
							level={2}
							title="No jobs match these filters"
							description={
								projectId
									? "Every job of this project is excluded by the current search, range, author, environment, status or type selection."
									: "Every job is excluded by the current search, range, author, environment, project, status or type selection."
							}
							action={
								<Button variant="outline" size="sm" onClick={reset}>
									Clear filters
								</Button>
							}
						/>
					) : (
						<TooltipProvider delayDuration={300}>
							{/* keepPreviousData: the previous rows stay visible, dimmed, while a
							    filter change — or a larger window — refetches (the standard's
							    isPlaceholderData rule). */}
							<div
								className={cn(
									"space-y-3 transition-opacity",
									page.isPlaceholderData && "opacity-60",
								)}
							>
								<DataTable
									columns={columns}
									data={rows}
									query={page}
									onRowClick={handleRowClick}
									// One page holding every row read: the window is the server's, so
									// the table pages nothing itself. `pageIndex` is what makes the
									// table follow `pageSize` as the window grows — without it the
									// size is read once, at mount.
									pageIndex={0}
									pageSize={Math.max(rows.length, 1)}
									scrollHeight="h-[70vh]"
								/>
								{rows.length > 0 && matched > rows.length && (
									<div className="flex flex-col items-center gap-2 px-1" data-slot="jobs-window">
										<p className="text-xs tabular-nums text-muted-foreground" role="status">
											{capped
												? `Showing the newest ${rows.length} of ${matched}. Narrow the filters to reach older jobs.`
												: `Showing the newest ${rows.length} of ${matched}`}
										</p>
										{hasMore && (
											<Button
												variant="outline"
												size="sm"
												disabled={page.isPlaceholderData}
												onClick={() =>
													setGrown({ view, limit: Math.min(limit + JOBS_PAGE_SIZE, JOBS_PAGE_MAX) })
												}
											>
												{page.isPlaceholderData ? "Loading…" : "Show more"}
											</Button>
										)}
									</div>
								)}
							</div>
						</TooltipProvider>
					)}
				</>
			)}
		</div>
	);
}
