"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Activity panel (ported from the Alethia Labs design "alerts-hub").
// The durable delivery ledger: the one-row `ListToolbar` (search + the delivery-status facet,
// see alerts-facets.ts) over a table. Bound to the real DeliveryDTO
// (event/status/attempts/when/error) — the design's per-policy and per-channel columns
// aren't in the DTO yet, so they're omitted.
//
// The table is `DataTable`, not the `grid-cols-[2fr_1fr_auto_1.2fr]` header row + matching
// data rows this used to hand-roll. That shape reached a screen reader as a stack of
// buttons: four columns of delivery data with nothing tying a cell to the word above it.
// The last-error line came off its own `col-span-full` row and now sits inside the Event
// cell, because a `<tr>` has no honest place for a second row about the same delivery.
//
// The ledger is a KEYSET list (lib/query/README.md → "Paging", #7489): `<DataTable keyset={…}>`
// renders every loaded page and `ListFooter` under it — a scroll sentinel plus an always-visible
// "Load more", a busy state, and "Couldn't load more · Try again" with the rows kept. It used to be
// the newest 50 (at most 200) deliveries, client-paged 20 at a time by DataTable's default, with a
// "Showing the newest N of M" line in place of any way to reach an older delivery. There is no
// result count anywhere now: the console carries no list counts (README → "Counts").
//
// #6125: the ledger is server-rendered with its rows now, so "When" — which reads the browser's
// time zone — renders after hydration in a width-reserving slot (React #418 otherwise). And the
// panel follows its list's FIRST-PAGE read state: the ledger's skeleton while the first answer is in
// flight, a region error when it failed with nothing to show, so "No activity yet" is only ever the
// answer to a read that found nothing — and it is the first-run copy only when `universeEmpty` says
// the org's ledger holds nothing at all, whatever the filters.

import type { ColumnDef } from "@tanstack/react-table";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import { activityToolbarFacets } from "@/components/alerts/alerts-facets";
import { DEFAULT_ACTIVITY_FILTERS } from "@/components/alerts/alerts-query";
import type { ActivityView } from "@/components/alerts/activity-view";
import { deliveryBadge } from "@/components/alerts/alerts-status";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { DataTable } from "@/components/data-table";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useAlertActivityFilters } from "@/lib/stores/use-alerts-filters";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { EmptyState } from "@repo/ui/empty";
import { FilterEmpty } from "@repo/ui/filter-bar";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { formatDate } from "@repo/format";
import { ClockSlot } from "@/components/overview/clock-slot";
import { RegionError } from "@repo/ui/region-error";
import { AlertsPanelSkeleton } from "@/components/alerts/alerts-skeleton";
import type { AssignedValue } from "@/lib/queries/classification";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";

/**
 * The stable empty map the classification query falls back to while it is in flight.
 *
 * A literal `= {}` in the destructuring mints a fresh object every render, so `columns`'
 * dependency changes on every render and the memo below buys nothing — TanStack's
 * `getAllColumns` then rebuilds all four columns and their handlers on mount and on any
 * refetch that clears `data`.
 */
const NO_ASSIGNMENTS: Record<string, AssignedValue[]> = {};

/** The widest "When" the ledger prints (`formatDate(…, "datetime")` in the console's locale). */
const WHEN_SIZER = "Sep 30, 2026, 12:00 PM";

/** Delivery activity log. */
export function ActivityPanel({
	view,
}: {
	/** The filter standard's resolved view — the keyset list, facets, staleness. */
	view: ActivityView;
}) {
	const { list, facets, stale } = view;
	const rows = list.rows;
	const state =
		list.query.data !== undefined ? "ready" : list.query.isError ? "error" : "loading";
	const filters = useAlertActivityFilters((s) => s.filters);
	const setFilter = useAlertActivityFilters((s) => s.set);
	const resetFilters = useAlertActivityFilters((s) => s.reset);
	// Three sections share the page, so `/` answers only the section in view (the scroll-spy's).
	const inView = useAlertsSection((s) => s.active === "activity");
	const { inputRef, shortcut } = useListSearchShortcut({ enabled: inView });
	// One batched query hydrates every delivery row's classification chips (read-only). The
	// ledger is filtered and paged SERVER-side, so the subject set is the rows loaded so far.
	const { data: classMap = NO_ASSIGNMENTS } = useAssignmentsForKind(
		"alert_delivery",
		rows.map((d) => d.id),
	);

	const columns = useMemo<ColumnDef<DeliveryDTO>[]>(
		() => buildColumns(classMap),
		[classMap],
	);

	return (
		<div>
			{state === "loading" ? (
				<AlertsPanelSkeleton kind="activity" />
			) : state === "error" ? (
				<RegionError title="Couldn't load activity" onRetry={() => void list.query.refetch()} />
			) : (
				<>
			<ListToolbar
				search={{
					value: filters.search,
					onChange: (value) => setFilter("search", value),
					placeholder: "Filter activity by title or event…",
					inputRef,
					shortcut,
				}}
				facets={activityToolbarFacets(filters, setFilter, facets)}
				reset={{ count: countActiveFilters(filters, DEFAULT_ACTIVITY_FILTERS), onReset: resetFilters }}
			/>

			{/* `stale` is the filter standard's `isPlaceholderData` dim: these rows are the
			    PREVIOUS query's answer, kept so the table does not blank, and marked so they are
			    not read as the current one. */}
			<div className={cn(stale && "opacity-60 transition-opacity")}>
				{/* An empty ledger is the SHARED empty state, not the table's muted empty row — the
				    same answer every console list gives, and the one the audit's F10 reads
				    (`[data-slot="empty"]`, #4939). It says which empty it is: nothing delivered
				    yet (`universeEmpty`), or nothing matching, and only the second offers Reset. */}
				{rows.length === 0 ? (
					list.universeEmpty === false ? (
						<FilterEmpty className="border" noun="deliveries" onClear={resetFilters} />
					) : (
						<EmptyState
							className="border"
							icon={<Activity />}
							title="No activity yet"
							description="Deliveries appear here once a policy routes an alert to a channel."
						/>
					)
				) : (
					<DataTable columns={columns} keyset={list} />
				)}
			</div>
				</>
			)}
		</div>
	);
}

/**
 * The ledger's four columns, in the order the hand-rolled grid had them.
 *
 * `classMap` is a parameter rather than a closure over the component body so the column list
 * memoises on the one thing it actually depends on.
 *
 * Every column sets `enableSorting: false`. An `accessorKey` column is sortable by default, and
 * `DataTable` hangs the toggle on a bare `<th onClick>` with `cursor-pointer` and no `tabIndex`,
 * `role`, `aria-sort` or button — four mouse-only controls with no announced state, on the one
 * table converted BECAUSE its grid reached a screen reader as a stack of buttons. The grid it
 * replaced did not sort either, so this is parity, not a removal. Sorting comes back here when
 * `DataTable`'s header renders a real button with `aria-sort`, which every other table wants too.
 */
function buildColumns(
	classMap: Record<string, AssignedValue[]>,
): ColumnDef<DeliveryDTO>[] {
	return [
		{
			accessorKey: "title",
			header: "Event",
			enableSorting: false,
			cell: ({ row }) => {
				const d = row.original;
				return (
					<div className="flex min-w-0 max-w-[420px] items-start gap-3 whitespace-normal">
						<StatusBadge
							{...deliveryBadge(d.status)}
							showLabel={false}
							className="mt-1 shrink-0"
						/>
						<div className="min-w-0">
							<div className="truncate text-ui-md">{d.title}</div>
							<div className="truncate font-mono text-ui-2xs text-muted-foreground">
								{d.event_key}
							</div>
							<ClassificationChips
								kind="alert_delivery"
								id={d.id}
								initialAssignments={classMap[d.id]}
								className="mt-1 flex"
							/>
							{d.last_error && (
								<div className="mt-1 break-words font-mono text-ui-2xs text-text-tertiary">
									{d.last_error}
								</div>
							)}
						</div>
					</div>
				);
			},
		},
		{
			accessorKey: "status",
			header: "Status",
			enableSorting: false,
			// The dot in the Event cell already carries the tier; this column carries its word.
			cell: ({ row }) => (
				<span className="font-mono text-ui-xs uppercase text-muted-foreground">
					{deliveryBadge(row.original.status).label}
				</span>
			),
		},
		{
			accessorKey: "attempts",
			header: "Attempts",
			enableSorting: false,
			cell: ({ row }) => (
				<span className="font-mono text-ui-xs tabular-nums text-muted-foreground">
					{row.original.attempts}
				</span>
			),
		},
		{
			accessorKey: "created_at",
			header: () => <div className="w-full text-right">When</div>,
			enableSorting: false,
			cell: ({ row }) => (
				<div className="text-right font-mono text-ui-2xs text-muted-foreground">
					<ClockSlot
						sizer={WHEN_SIZER}
						render={() => formatDate(row.original.created_at, "datetime")}
					/>
				</div>
			),
		},
	];
}
