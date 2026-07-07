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
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type ActivityQuery,
	type ActivityRow,
	getActivityExportCsv,
	getActivityLog,
} from "@/app/server/actions/activity";
import { getMembers, type MemberRow } from "@/app/server/actions/members";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { SettingsSearch } from "@/components/settings/settings-ui";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FacetFilter } from "@repo/ui/facet-filter";
import { GroupedFilterSheet } from "@repo/ui/grouped-filter-sheet";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";
import { ActivityFeed } from "./activity-feed";
import { type ActivityContext, EVENT_GROUPS } from "./humanize-event";

const DAY = 86_400_000;
// A small grace so a preset that lands exactly on the retention boundary (e.g. Hobby's
// "Last 7 days") isn't tripped as "too far back" by the few ms between resolving the
// preset and re-reading the clock in the guard.
const RETENTION_GRACE = 3_600_000;
const SEARCH_DEBOUNCE = 300;

/** Splits the event-type tokens into the resource-type + decision filters the query takes. */
function splitEventTokens(tokens: string[]): {
	resourceTypes: string[];
	decision: boolean | null;
} {
	const resourceTypes = tokens
		.filter((t) => t.startsWith("type:"))
		.map((t) => t.slice(5));
	const results = tokens
		.filter((t) => t.startsWith("result:"))
		.map((t) => t.slice(7));
	// One side selected → that decision; both/none → no constraint.
	const decision = results.length === 1 ? results[0] === "allow" : null;
	return { resourceTypes, decision };
}

/** The org Activity feed. Pass `projectId` (a project id) to scope it to a single project's
 * events — used by `/{org}/{project}/settings/activity`; the Project facet is then hidden. */
export function ActivityLog({ projectId }: { projectId?: string } = {}) {
	const orgSlug = useActiveOrgSlug();
	const canExport = useEntitlement("activityExport");
	const retentionDays = useWorkspaceStore(
		(s) => s.entitlements?.quotas.activityRetentionDays ?? 7,
	);
	const { data: projects = [] } = useProjectsQuery();

	const [members, setMembers] = useState<MemberRow[]>([]);

	// Paged results (accumulated across "Load more").
	const [rows, setRows] = useState<ActivityRow[]>([]);
	const [nextCursor, setNextCursor] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);

	// Filters.
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days",
	);
	const [actorIds, setActorIds] = useState<string[]>([]);
	const [projectIds, setProjectIds] = useState<string[]>([]);
	const [eventTokens, setEventTokens] = useState<string[]>([]);

	const [exporting, setExporting] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);

	// Members drive the filter options + the humanizer's name resolution (projects come
	// from the shared query cache).
	useEffect(() => {
		getMembers()
			.then(setMembers)
			.catch(() => setMembers([]));
	}, []);

	// Debounce the free-text search so it doesn't refetch on every keystroke.
	useEffect(() => {
		const id = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE);
		return () => clearTimeout(id);
	}, [search]);

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

	// The query the current filters describe (sans cursor). When the feed is locked to a
	// `projectId` (project settings) that scope is forced; otherwise the Project facet drives
	// the `resourceIds` (the selected project ids), keeping scoping server-side + page-correct.
	const query = useMemo<ActivityQuery>(() => {
		const { resourceTypes, decision } = splitEventTokens(eventTokens);
		const resourceIds = projectId
			? [projectId]
			: projectIds.length
				? projectIds
				: undefined;
		return {
			from: range.from.toISOString(),
			to: range.to.toISOString(),
			actorIds: actorIds.length ? actorIds : undefined,
			resourceTypes: resourceTypes.length ? resourceTypes : undefined,
			decision,
			resourceIds,
			search: debouncedSearch.trim() || undefined,
		};
	}, [range, actorIds, projectIds, eventTokens, debouncedSearch, projectId]);

	// (Re)load the first page whenever the filters change.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getActivityLog(query)
			.then((page) => {
				if (cancelled) return;
				setRows(page.rows);
				setNextCursor(page.nextCursor);
			})
			.catch(() => {
				if (cancelled) return;
				setRows([]);
				setNextCursor(null);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	/** Fetch the next page (older rows) and append it. */
	const onLoadMore = useCallback(async () => {
		if (nextCursor == null || loadingMore) return;
		setLoadingMore(true);
		try {
			const page = await getActivityLog({ ...query, cursor: nextCursor });
			setRows((prev) => [...prev, ...page.rows]);
			setNextCursor(page.nextCursor);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to load more activity");
		} finally {
			setLoadingMore(false);
		}
	}, [query, nextCursor, loadingMore]);

	/** Apply a picked range, or prompt upgrade when it predates the plan's retention. */
	const applyRange = useCallback(
		(next: DateRange, label?: string) => {
			const minFrom = Date.now() - retentionDays * DAY - RETENTION_GRACE;
			if (next.from.getTime() < minFrom) {
				setUpgradeOpen(true);
				return;
			}
			setRange(next);
			if (label !== undefined) setRangeLabel(label);
		},
		[retentionDays],
	);

	const userOptions = useMemo(
		() =>
			members.map((m) => ({
				value: m.userId,
				label: m.name?.trim() || m.email,
				hint: m.name?.trim() ? m.email : undefined,
			})),
		[members],
	);
	const projectOptions = useMemo(
		() => projects.map((p) => ({ value: p.id, label: p.project_name })),
		[projects],
	);

	async function onExport() {
		setExporting(true);
		try {
			const csv = await getActivityExportCsv();
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "activity-log.csv";
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Export failed");
		} finally {
			setExporting(false);
		}
	}

	const projectName = projectId ? lookups.projectName.get(projectId) : undefined;

	return (
		<div>
			{projectId && (
				<p className="mb-3 text-[13px] text-text-tertiary">
					Activity in{" "}
					<span className="font-medium text-text-secondary">
						{projectName ?? "this project"}
					</span>
					.
				</p>
			)}
			{/* filter bar */}
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<SettingsSearch
					value={search}
					onChange={setSearch}
					placeholder="Search actor, action or resource"
					className="w-[240px] flex-1"
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
					value={actorIds}
					onChange={setActorIds}
					searchPlaceholder="Search members…"
					emptyText="No members."
				/>
				{/* Project scope is locked when the feed is pinned to a project — hide the facet. */}
				{!projectId && (
					<FacetFilter
						label="Project"
						icon={Boxes}
						options={projectOptions}
						value={projectIds}
						onChange={setProjectIds}
						searchPlaceholder="Search projects…"
						emptyText="No projects."
					/>
				)}
				<GroupedFilterSheet
					label="Events"
					icon={ListFilter}
					groups={EVENT_GROUPS}
					value={eventTokens}
					onChange={setEventTokens}
					title="Filter by event"
					description="Show only the event types you care about."
				/>
				{/* Export dumps the whole org log, so it only belongs on the org-scoped feed. */}
				{!projectId && (
					<Button
						variant="outline"
						size="sm"
						disabled={!canExport || exporting}
						title={
							canExport ? undefined : "Activity export requires the Enterprise plan"
						}
						onClick={() => void onExport()}
					>
						<Download size={13} />
						Export CSV
					</Button>
				)}
			</div>

			{loading && rows.length === 0 ? (
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : (
				<ActivityFeed
					rows={rows}
					ctx={ctx}
					onLoadMore={() => void onLoadMore()}
					hasMore={nextCursor != null}
					loadingMore={loadingMore}
				/>
			)}

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
