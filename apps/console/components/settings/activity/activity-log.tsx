"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity — a Vercel-style natural-language feed of the org's Activity events
// (every recorded action + denials), fronted by reusable filters: time-range (quick + calendar),
// User, Project, and an event-type sheet. Viewing is available on every plan; CSV export is
// Enterprise-gated, and time windows older than the plan's retention prompt an upgrade.
// Filtering + pagination are server-side (cursor by id): every filter change refetches page 1,
// and "Load more" pages in older rows. Resource names are resolved from the projects store +
// members for the humanizer; the Project filter is resolved to project ids server-side. When
// pinned to a `projectId` (project settings) the feed locks to that project and hides the facet.

import { Boxes, Download, ListFilter, Users } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type ActivityPage,
	type ActivityRow,
	getActivityExportCsv,
} from "@/app/server/actions/activity";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useHydrated } from "@/hooks/use-hydrated";
import { useActivityQuery, useMembersQuery } from "@/lib/query/use-activity-query";
import { RegionError } from "@/components/errors/region-error";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { GroupedFilterSheet } from "@repo/ui/grouped-filter-sheet";
import { SectionHeading } from "@repo/ui/section-heading";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type ActivityWindow,
	activityQueryFrom,
	activityRange,
	DEFAULT_ACTIVITY_FILTERS,
} from "./activity-filters";
import { ActivityFeed } from "./activity-feed";
import { ActivityNoAccess } from "./activity-no-access";
import { type ActivityContext, EVENT_GROUPS } from "./humanize-event";

const DAY = 86_400_000;
// A small grace so a preset that lands exactly on the retention boundary (e.g. Hobby's
// "Last 7 days") isn't tripped as "too far back" by the few ms between resolving the
// preset and re-reading the clock in the guard.
const RETENTION_GRACE = 3_600_000;
const SEARCH_DEBOUNCE = 300;

/** One counted facet option as the server returns it. */
type FacetCount = NonNullable<ActivityPage["facets"]>["actors"][number];

/** A facet's options as a value → count lookup (empty while the facets are unknown). */
function facetCounts(options: FacetCount[] | undefined): Map<string, number> {
	return new Map((options ?? []).map((o) => [o.value, o.count]));
}

/** The count behind one Events-sheet token: `type:<resource_type>` or `result:<allow|deny>`. */
function eventTokenCount(
	token: string,
	types: Map<string, number>,
	decisions: Map<string, number>,
): number {
	if (token.startsWith("type:")) return types.get(token.slice(5)) ?? 0;
	if (token.startsWith("result:")) return decisions.get(token.slice(7)) ?? 0;
	return 0;
}

/** The default range picker's trigger label. */
const DEFAULT_RANGE_LABEL =
	RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days";

/** The org Activity feed. Pass `projectId` (a project id) to scope it to a single project's
 * events — used by `/{org}/{project}/settings/activity`; the Project facet is then hidden.
 * `exportPermitted` is the caller's `activity:export_activity` decision, resolved server-side by
 * the page (#3932); it only decides whether the button is offered — `getActivityExportCsv`
 * enforces the permission itself, so a stale `true` here still ends in a refusal.
 *
 * #6129: `defaultWindow` is the default time window the ROUTE resolved, and under which it
 * prefetched the first page — so the feed asks for exactly that key and paints with rows (B1).
 * `exportEntitled` is the plan's answer as the route resolved it, so the Export button is decided
 * at first paint rather than after the workspace store loads. */
export function ActivityLog({
	projectId,
	exportPermitted = false,
	exportEntitled: exportEntitledAtRender,
	defaultWindow,
}: {
	projectId?: string;
	exportPermitted?: boolean;
	exportEntitled?: boolean;
	defaultWindow?: ActivityWindow;
} = {}) {
	const orgSlug = useActiveOrgSlug();
	// The route's answer when it gave one; otherwise the workspace store's, which is `null` while it
	// has not answered (#5864): the Export button is then not rendered at all, rather than shown
	// disabled with the "requires Enterprise" reason to an org that may well have it.
	const storeExportEntitled = useEntitlement("activityExport");
	const exportEntitled =
		exportEntitledAtRender === true || storeExportEntitled === true
			? true
			: (exportEntitledAtRender ?? storeExportEntitled);
	const canExport = exportEntitled === true && exportPermitted;
	// The plan's retention, or `null` while it is unknown — the same store, the same third state.
	const retentionDays = useWorkspaceStore(
		(s) => s.entitlements?.quotas.activityRetentionDays ?? null,
	);
	const { data: projects = [] } = useProjectsQuery();

	// Members drive the filter options + the humanizer's name resolution (projects come
	// from the shared query cache; members from theirs — no fetch-into-state effect).
	const { data: members = [] } = useMembersQuery();

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key. Nine `useState` calls
	// collapse to one store plus the two that are genuinely not filters (export + upgrade).
	const filters = useActivityFilters((s) => s.filters);
	const set = useActivityFilters((s) => s.set);
	const patch = useActivityFilters((s) => s.patch);
	const reset = useActivityFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useActivityFilters, DEFAULT_ACTIVITY_FILTERS);
	const hydrated = useHydrated();
	const debouncedSearch = useDebouncedValue(filters.search, SEARCH_DEBOUNCE, { urlRead });

	// The default window is resolved ONCE — by the route when it prefetched (so the key matches the
	// prefetched page), else here at mount. Resolving it per render would move `to` forward every
	// time and produce a query key that never settles, refetching on every paint.
	const [defaultRange] = useState<DateRange>(() =>
		defaultWindow
			? { from: new Date(defaultWindow.from), to: new Date(defaultWindow.to) }
			: presetRange(DEFAULT_PRESET),
	);
	const range = useMemo(
		() => activityRange(filters, defaultRange),
		[filters, defaultRange],
	);
	const rangeLabel = filters.rangeLabel || DEFAULT_RANGE_LABEL;

	const [upgradeOpen, setUpgradeOpen] = useState(false);

	// Resource-name lookups that drive the humanizer's name resolution.
	const lookups = useMemo(() => {
		const projectName = new Map<string, string>();
		for (const p of projects) projectName.set(p.id, p.project_name);
		const memberName = new Map<string, string>();
		for (const m of members) memberName.set(m.userId, m.name?.trim() || m.email);
		return { projectName, memberName };
	}, [projects, members]);

	const ctx = useMemo<ActivityContext>(
		() => ({
			resolveName: (type, id) => {
				if (!id) return null;
				if (type === "project") return lookups.projectName.get(id) ?? null;
				if (type === "member" || type === "invitation")
					return lookups.memberName.get(id) ?? null;
				return null;
			},
		}),
		[lookups],
	);

	// The NORMALIZED query the current filters describe (sans cursor) — it IS the query
	// key, so equal filters hit the cache (the standard). When the feed is locked to a
	// `projectId` (project settings) that scope is forced; otherwise the Project facet
	// drives the `resourceIds` (the selected project ids), keeping scoping server-side.
	const query = useMemo(
		() =>
			activityQueryFrom({
				filters,
				range,
				search: debouncedSearch,
				pinnedProjectId: projectId,
			}),
		[filters, range, debouncedSearch, projectId],
	);

	// Cursor-paginated fetch, filters in the key, keepPreviousData across filter changes —
	// replaces the raw `useEffect` + `cancelled`-flag chain (forbidden by the standard).
	const activity = useActivityQuery(query);
	const rows = useMemo<ActivityRow[]>(
		() => (activity.data?.pages ?? []).flatMap((p) => p.rows),
		[activity.data],
	);
	const nextCursor = activity.data?.pages.at(-1)?.nextCursor ?? null;
	const loading = activity.isPending;
	const loadingMore = activity.isFetchingNextPage;
	// The other half of `keepPreviousData` (lib/query/README.md, step 5). Keeping the rows is
	// only half the standard: without the dim the feed renders the PREVIOUS filter's rows as
	// though they were the answer to the one you just picked, which is a worse lie than a
	// skeleton. `isPlaceholderData` is true for exactly the window between the filter change
	// and the new page landing.
	const stale = activity.isPlaceholderData;
	// The feed is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the jobs and runners
	// lists' rule (#4980, #5045). Before the first answer this feed renders a skeleton with no count,
	// no table and no empty state, which nothing else on screen tells apart from a page that failed
	// to render a list; `aria-busy` says which, for assistive tech and for the audit's F8–F9 read,
	// which took two such reads for the list's answer (#5471).
	const busy = !urlRead || activity.isPending || stale || filters.search !== debouncedSearch;

	/** Fetch the next page (older rows); TanStack appends it to `pages`. */
	const onLoadMore = useCallback(async () => {
		if (nextCursor == null || loadingMore) return;
		try {
			await activity.fetchNextPage();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to load more activity");
		}
	}, [activity, nextCursor, loadingMore]);

	/** Apply a picked range, or prompt upgrade when it predates the plan's retention. While the
	 * retention is unknown, a range inside the community floor applies and an older one does
	 * neither — it unlocks no paid history and offers no upgrade to an org that may have it. */
	const applyRange = useCallback(
		(next: DateRange, label: string) => {
			const days = retentionDays ?? COMMUNITY_ENTITLEMENTS.quotas.activityRetentionDays;
			const minFrom = Date.now() - days * DAY - RETENTION_GRACE;
			if (next.from.getTime() < minFrom) {
				if (retentionDays !== null) setUpgradeOpen(true);
				return;
			}
			patch({
				from: next.from.toISOString(),
				to: next.to.toISOString(),
				rangeLabel: label,
			});
		},
		[retentionDays, patch],
	);

	// The facet counts come from the server's facet passes (lib/queries/activity.ts), which see
	// the scope and none of the filters — so a count holds still as you select options, the
	// standard's unfiltered-universe rule. They ride on the FIRST page only; while it loads the
	// options render without a figure rather than with a zero that is not yet true.
	const facets = activity.data?.pages[0]?.facets ?? null;

	// Options are the org's FULL member / project lists (their own shared query caches), never
	// the rows on screen, so an option cannot vanish as it is selected. An actor the log knows
	// and the member list no longer does (someone who left) is appended from the facet, so their
	// events stay one filter away.
	const userOptions = useMemo(() => {
		const counts = facetCounts(facets?.actors);
		const options = members.map((m) => ({
			value: m.userId,
			label: m.name?.trim() || m.email,
			hint: m.name?.trim() ? m.email : undefined,
			count: facets ? (counts.get(m.userId) ?? 0) : undefined,
		}));
		const known = new Set(members.map((m) => m.userId));
		for (const a of facets?.actors ?? []) {
			if (known.has(a.value)) continue;
			options.push({
				value: a.value,
				label: a.label ?? "Former member",
				hint: undefined,
				count: a.count,
			});
		}
		return options;
	}, [members, facets]);
	const projectOptions = useMemo(() => {
		const counts = facetCounts(facets?.projects);
		return projects.map((p) => ({
			value: p.id,
			label: p.project_name,
			count: facets ? (counts.get(p.id) ?? 0) : undefined,
		}));
	}, [projects, facets]);
	const eventGroups = useMemo(() => {
		if (!facets) return EVENT_GROUPS;
		const types = facetCounts(facets.resourceTypes);
		const decisions = facetCounts(facets.decisions);
		return EVENT_GROUPS.map((g) => ({
			...g,
			options: g.options.map((o) => ({
				...o,
				count: eventTokenCount(o.value, types, decisions),
			})),
		}));
	}, [facets]);
	const activeFilters = countActiveFilters(filters, DEFAULT_ACTIVITY_FILTERS);

	// The export through the mutation contract: pending disables the button (no second export while
	// one runs), a plan refusal opens the upgrade sheet, a permission refusal is one toast with the
	// server's sentence, and an unexpected failure never shows server text. It changes no data the
	// page shows, so it invalidates nothing.
	const exportCsv = useActionMutation(getActivityExportCsv, {
		invalidates: [],
		onEntitlement: () => setUpgradeOpen(true),
		onSuccess: (csv) => {
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "activity-log.csv";
			a.click();
			URL.revokeObjectURL(url);
		},
	});
	const exporting = exportCsv.isPending;

	// The topbar's project switcher reads the same projects query and may have fetched it by the
	// time this feed hydrates; the server rendered "this project". Name it only once hydration is
	// over, or React discards the page's server HTML with #418 (see `useHydrated`, #5786).
	const projectName = projectId && hydrated ? lookups.projectName.get(projectId) : undefined;

	// Refused while the page is open (the viewer's `view_activity` went away): the no-access render,
	// never the failure below and never an empty feed (B4).
	if (readRefusalOf(activity.error) === "forbidden") return <ActivityNoAccess />;

	return (
		<div aria-busy={busy}>
			{projectId && (
				<p className="mb-3 text-ui-md text-text-tertiary">
					Activity in{" "}
					<span className="font-medium text-text-secondary">
						{projectName ?? "this project"}
					</span>
					.
				</p>
			)}
			{/* The result count lives beside the heading, never as prose in the bar. This feed is
			    cursor-paginated, so it counts the rows LOADED so far — "42" here means 42 on
			    screen, and "Load more" moves it.

			    `SectionHeading`'s `count` renders through the same `CountPill` this used to mount by
			    hand, which is the whole reason the pair belongs to the primitive: the standard
			    says where a result count goes, and a local heading + pill is a second answer to a
			    question already settled. */}
			<SectionHeading
				className="mb-3"
				title="Activity"
				count={loading ? null : rows.length}
			/>

			<FilterBar
				end={
					// `end` is the primitive's slot for a page-level action; export dumps the
					// WHOLE org log, so it only belongs on the org-scoped feed.
					!projectId && exportEntitled !== null ? (
						<Button
							variant="outline"
							size="sm"
							disabled={!canExport || exporting}
							title={
								exportEntitled === false
									? "Activity export requires the Enterprise plan"
									: !exportPermitted
										? "Your role does not include exporting the Activity log"
										: undefined
							}
							onClick={() => exportCsv.mutate({})}
						>
							<Download size={13} />
							Export CSV
						</Button>
					) : undefined
				}
			>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search actor, action or resource…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<QuickRangeFilter
					label={rangeLabel}
					value={range}
					onChange={(r, l) => applyRange(r, l)}
				/>
				<DateRangeFilter
					value={range}
					onChange={(r) => applyRange(r, formatRangeLabel(r))}
				/>
				<FacetFilter
					label="User"
					icon={Users}
					options={userOptions}
					value={filters.actorIds}
					onChange={(next) => set("actorIds", next)}
					searchPlaceholder="Search members…"
					emptyText="No members."
				/>
				{/* Project scope is locked when the feed is pinned to a project — hide the facet. */}
				{!projectId && (
					<FacetFilter
						label="Project"
						icon={Boxes}
						options={projectOptions}
						value={filters.projectIds}
						onChange={(next) => set("projectIds", next)}
						searchPlaceholder="Search projects…"
						emptyText="No projects."
					/>
				)}
				<GroupedFilterSheet
					label="Events"
					icon={ListFilter}
					groups={eventGroups}
					value={filters.eventTokens}
					onChange={(next) => set("eventTokens", next)}
					title="Filter by event"
					description="Show only the event types you care about."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{activity.isError ? (
				// A fetch failure must not render as an empty activity feed.
				<RegionError
					title="Couldn't load activity"
					description="Something went wrong fetching the activity log. Check your connection and try again."
					onRetry={() => activity.refetch()}
				/>
			) : loading && rows.length === 0 ? (
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : (
				<div className={stale ? "opacity-60 transition-opacity" : undefined}>
					<ActivityFeed
						rows={rows}
						ctx={ctx}
						onLoadMore={() => void onLoadMore()}
						hasMore={nextCursor != null}
						loadingMore={loadingMore}
					/>
				</div>
			)}

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
