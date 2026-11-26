"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity — a Vercel-style natural-language feed of the org's Activity events
// (every recorded action + denials), fronted by reusable filters: time-range (quick + calendar),
// User, Project, and an event-type sheet. Viewing is available on every plan; CSV export is
// Enterprise-gated, and time windows older than the plan's retention prompt an upgrade.
// Filtering + pagination are server-side, on the console's one keyset contract (`useKeysetList` +
// `ListFooter`, LST-10 #7492): every filter change restarts at page one, and the footer's sentinel
// and "Load more" page in older rows. A row carries the resource's name as it was recorded with
// the event (#6735); only a row without one (older rows, people) is named from the projects store +
// members, which cannot name what has since been deleted. The Project filter is resolved to
// project ids server-side. When
// pinned to a `projectId` (project settings) the feed locks to that project and hides the facet.

import { Boxes, Download, ListFilter, ScrollText, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ListFooter } from "@/components/list/list-footer";
import {
	type ActivityPage,
	type ActivityRow,
	getActivityExportCsv,
} from "@/app/server/actions/activity";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import {
	parseRangeFilter,
	rangeFilterLabel,
	rangeFromPick,
	rangeWindowValue,
} from "@/lib/query/range-filter";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useHydrated } from "@repo/ui/use-hydrated";
import { useMembersQuery } from "@/lib/query/use-activity-query";
import { normalizeActivityQuery } from "@/lib/query/activity-query";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { RegionError } from "@repo/ui/region-error";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { GroupedFilterSheet } from "@repo/ui/grouped-filter-sheet";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import {
	type ActivityWindow,
	activityFiltersFromUrl,
	activityQueryFrom,
	activityRange,
	DEFAULT_ACTIVITY_FILTERS,
	RETIRED_ACTIVITY_PARAMS,
} from "./activity-filters";
import { ActivityFeed } from "./activity-feed";
import { ActivityNoAccess } from "./activity-no-access";
import { ActivityRowsSkeleton } from "./activity-skeleton";
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
	//
	// THE LINK IS THE FIRST RENDER'S SOURCE OF TRUTH (#6320). The route prefetched the first page
	// from the link's filters (`activityQueryFromUrl`), so until the link has been read into the
	// store this renders those same filters — read from the same params with the same decode — and
	// the browser's first key IS the prefetched key. The store cannot be trusted for that render:
	// it outlives a client-side navigation, and a range picked on an earlier visit used to override
	// "Last 7 days" and swap the first paint's rows after hydration (B1). For the same reason the
	// mount REPLACES the store with the link's filters rather than patching the ones it names.
	//
	// The replace is declared AFTER `useFilterUrlSync` (#6740). That hook's mount enters the page's
	// scope, which drops any other scope's filters, and it decodes only the current params. The
	// link's filters here also read an OLD `from`/`to` link as its window
	// (`activityFiltersFromUrl`), so they must land last. The replace changes the filters, so the
	// hook's store → URL write runs again on the next commit and writes the replaced state.
	const searchParams = useSearchParams();
	const [linkFilters] = useState(() => activityFiltersFromUrl(searchParams));
	const storeFilters = useActivityFilters((s) => s.filters);
	const set = useActivityFilters((s) => s.set);
	const reset = useActivityFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useActivityFilters, DEFAULT_ACTIVITY_FILTERS, undefined, {
		retiredParams: RETIRED_ACTIVITY_PARAMS,
	});
	useEffect(() => {
		useActivityFilters.setState({ filters: linkFilters });
	}, [linkFilters]);
	const filters = urlRead ? storeFilters : linkFilters;
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
	// One choice, one label: the default preset's name, a picked preset's name, or "Custom range"
	// for an explicit window, never a relative name over fixed bounds (#6740).
	const rangeLabel = rangeFilterLabel(parseRangeFilter(filters.range), DEFAULT_RANGE_LABEL);

	// The shell's ONE upgrade sheet (R6 F-31): this feed used to mount a second UpgradeOrgSheet.
	const { openUpgrade } = useUpgradeSheet();

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
	// `activityQueryFrom` already normalizes; normalizing again at the key is idempotent, and makes
	// "the key is the normalized query" a fact of this module rather than of a helper a module away.
	const query = useMemo(() => normalizeActivityQuery(
		activityQueryFrom({
			filters,
			range,
			search: debouncedSearch,
			pinnedProjectId: projectId,
		}),
	), [filters, range, debouncedSearch, projectId]);

	// The shared keyset read: the normalized filters are the whole key, the cursor is the page
	// param, keepPreviousData holds the old rows across a filter change, and rows are joined across
	// pages keeping each id once — so a live hint (an `activity` topic invalidation, ADR 0005) that
	// refetches the walk from page one never draws a row twice (lib/query/use-keyset-list.ts).
	const activity = useKeysetList(orpc.activity.page, query);
	const rows = activity.rows;
	const loading = activity.isPending;
	// The other half of `keepPreviousData` (lib/query/README.md, step 5). Keeping the rows is
	// only half the standard: without the dim the feed renders the PREVIOUS filter's rows as
	// though they were the answer to the one you just picked, which is a worse lie than a
	// skeleton. `isPlaceholderData` is true for exactly the window between the filter change
	// and the new page landing.
	const stale = activity.isPlaceholderData;
	// The feed is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the jobs and runners
	// lists' rule (#4980, #5045). Before the first answer this feed renders a skeleton with no
	// table and no empty state, which nothing else on screen tells apart from a page that failed
	// to render a list; `aria-busy` says which, for assistive tech and for the audit's F8–F9 read,
	// which took two such reads for the list's answer (#5471).
	const busy = !urlRead || activity.isPending || stale || filters.search !== debouncedSearch;
	// `query.isError` is a first-page or refresh failure only; a failed LATER page is the footer's.
	const firstPageFailed = activity.query.isError && activity.query.data === undefined;
	const refreshFailed = activity.query.isError && activity.query.data !== undefined;

	/** Apply a picked range, or prompt upgrade when it predates the plan's retention. While the
	 * retention is unknown, a range inside the community floor applies and an older one does
	 * neither — it unlocks no paid history and offers no upgrade to an org that may have it. */
	const applyRange = useCallback(
		(next: DateRange, label: string | null) => {
			const days = retentionDays ?? COMMUNITY_ENTITLEMENTS.quotas.activityRetentionDays;
			const minFrom = Date.now() - days * DAY - RETENTION_GRACE;
			if (next.from.getTime() < minFrom) {
				if (retentionDays !== null) openUpgrade();
				return;
			}
			set("range", label === null ? rangeWindowValue(next) : rangeFromPick(next, label));
		},
		[retentionDays, set, openUpgrade],
	);

	// The facet counts come from the server's facet passes (lib/queries/activity.ts), which see
	// the scope and none of the filters — so a count holds still as you select options, the
	// standard's unfiltered-universe rule. They ride on the FIRST page only; while it loads the
	// options render without a figure rather than with a zero that is not yet true.
	const facets = activity.facets;

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
	/** The filters other than the time window: what makes an empty feed "nothing matches". */
	const narrowingFilters = countActiveFilters(
		{ ...filters, range: DEFAULT_ACTIVITY_FILTERS.range },
		DEFAULT_ACTIVITY_FILTERS,
	);
	/**
	 * Whether this scope's log is empty whatever the filters and the window, or null while unknown —
	 * the first page's `universeEmpty`, which is what tells a new organization from a quiet week.
	 */
	const universeEmpty = activity.universeEmpty;

	// The export through the mutation contract: pending disables the button (no second export while
	// one runs), a plan refusal opens the upgrade sheet, a permission refusal is one toast with the
	// server's sentence, and an unexpected failure never shows server text. It changes no data the
	// page shows, so it invalidates nothing.
	const exportCsv = useActionMutation(getActivityExportCsv, {
		invalidates: [],
		onEntitlement: () => openUpgrade(),
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
	if (readRefusalOf(activity.query.error) === "forbidden") return <ActivityNoAccess />;

	return (
		<div aria-busy={busy}>
			{/* The page opens with its toolbar, not a heading that repeats the breadcrumb (R6 E-28):
			    one line saying what the feed is, and Export. No count: the feed is keyset-paged, so a
			    figure could only be the rows LOADED so far, which reads as a total (#7481).
			    Export dumps the WHOLE org log, so it only belongs on the org-scoped feed; when the plan
			    or the role does not allow it, it is disabled WITH the reason (R6 E-09), which a
			    disabled button's `title` never showed anyone. */}
			<PageToolbar
				className="mb-4"
				description={
					projectId ? (
						<>
							Activity in{" "}
							<span className="font-medium text-text-secondary">
								{projectName ?? "this project"}
							</span>
							.
						</>
					) : (
						"Every recorded action and access decision in this organization."
					)
				}
				actions={
					!projectId && exportEntitled !== null ? (
						<DisabledReason
							reason={
								exportEntitled === false
									? "Activity export requires the Enterprise plan."
									: !exportPermitted
										? "Your role does not include exporting the Activity log."
										: null
							}
						>
							<Button
								variant="outline"
								size="sm"
								disabled={!canExport || exporting}
								aria-busy={exporting || undefined}
								onClick={() => exportCsv.submit({})}
							>
								<Download size={13} />
								{exporting ? "Exporting…" : "Export CSV"}
							</Button>
						</DisabledReason>
					) : undefined
				}
			/>

			<FilterBar>
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
					onChange={(r) => applyRange(r, null)}
				/>
				<FacetFilter
					// "Member", Settings' word for a person in the org (R6 E-25); the facet lists members.
					label="Member"
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

			{firstPageFailed ? (
				// A failed FIRST load is an error, never an empty feed. Once rows are on screen a later
				// failure never replaces them (R6 E-26): a failed "Load more" is said under the rows
				// it would have extended, and a failed background refresh keeps what was loaded.
				<RegionError
					title="Couldn't load activity"
					description="Something went wrong fetching the activity log. Check your connection and try again."
					onRetry={() => void activity.query.refetch()}
				/>
			) : loading && rows.length === 0 ? (
				<ActivityRowsSkeleton rows={6} />
			) : (
				<div className={stale ? "opacity-60 transition-opacity" : undefined}>
					{refreshFailed && (
						<p role="status" className="mb-3 flex items-center gap-2 text-ui-sm text-text-secondary">
							Couldn&apos;t refresh the activity log; showing what was loaded.
							<Button variant="outline" size="sm" onClick={() => void activity.query.refetch()}>
								Try again
							</Button>
						</p>
					)}
					<ActivityFeed
						rows={rows}
						ctx={ctx}
						empty={
							<ActivityEmpty
								narrowed={narrowingFilters > 0}
								universeEmpty={universeEmpty}
								pinnedToProject={projectId !== undefined}
								// The wider window is offered only on the default window, and only to a plan
								// whose retention reaches it — never as a button that opens an upsell.
								canWiden={
									filters.range === DEFAULT_ACTIVITY_FILTERS.range &&
									retentionDays !== null &&
									retentionDays >= 30
								}
								onClearFilters={reset}
								onWiden={() => applyRange(presetRange("30d"), WIDER_RANGE_LABEL)}
							/>
						}
						footer={<ListFooter list={activity} />}
					/>
				</div>
			)}
		</div>
	);
}

/** The wider window the quiet-window empty state offers. */
const WIDER_RANGE_LABEL = RANGE_PRESETS.find((p) => p.id === "30d")?.label ?? "Last 30 days";

/**
 * Why the feed is empty, said as one of three different answers (R6 E-27):
 *
 * - **filtered** — something beyond the time window narrows the feed; the sentence the alerts
 *   activity panel and the QA flow catalog already pin, with Clear filters;
 * - **new** — the scope's whole log is empty, whatever the window (`universeEmpty`, which the
 *   server answers from the facet passes, and they see no window);
 * - **quiet** — the log has events, none in this window; offered the wider window when the window
 *   is still the default and the plan's retention reaches it.
 *
 * While `universeEmpty` is unknown, an unfiltered empty feed is the quiet answer.
 */
function ActivityEmpty({
	narrowed,
	universeEmpty,
	pinnedToProject,
	canWiden,
	onClearFilters,
	onWiden,
}: {
	narrowed: boolean;
	universeEmpty: boolean | null;
	pinnedToProject: boolean;
	canWiden: boolean;
	onClearFilters: () => void;
	onWiden: () => void;
}) {
	if (narrowed) {
		return (
			<EmptyState
				className="bg-surface-sunken"
				icon={<ScrollText />}
				title="No activity matches these filters."
				description="Clear the filters to see every event in this time range."
				action={
					<Button variant="outline" size="sm" onClick={onClearFilters}>
						Clear filters
					</Button>
				}
			/>
		);
	}
	if (universeEmpty === true) {
		return (
			<EmptyState
				className="bg-surface-sunken"
				icon={<ScrollText />}
				title={pinnedToProject ? "This Project has no activity yet" : "No activity yet"}
				description={
					pinnedToProject
						? "Changes to this Project and the access decisions made on it appear here as they happen."
						: "Every change made in this organization, and every access decision, appears here as it happens."
				}
			/>
		);
	}
	return (
		<EmptyState
			className="bg-surface-sunken"
			icon={<ScrollText />}
			title="Nothing recorded in this time range"
			description="Nothing was recorded in this window. Earlier events are one range away."
			action={
				canWiden ? (
					<Button variant="outline" size="sm" onClick={onWiden}>
						Show the {WIDER_RANGE_LABEL.toLowerCase()}
					</Button>
				) : undefined
			}
		/>
	);
}
