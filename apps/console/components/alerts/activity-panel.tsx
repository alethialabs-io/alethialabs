"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Activity panel (ported from the Alethia Labs design "alerts-hub").
// The durable delivery ledger: the standard filter bar (search + delivery-status chips,
// see alerts-filter-bar.tsx) over a table. Bound to the real DeliveryDTO
// (event/status/attempts/when/error) — the design's per-policy and per-channel columns
// aren't in the DTO yet, so they're omitted.
//
// The table is `DataTable`, not the `grid-cols-[2fr_1fr_auto_1.2fr]` header row + matching
// data rows this used to hand-roll. That shape reached a screen reader as a stack of
// buttons: four columns of delivery data with nothing tying a cell to the word above it.
// The last-error line came off its own `col-span-full` row and now sits inside the Event
// cell, because a `<tr>` has no honest place for a second row about the same delivery.
//
// The result count is NOT in the bar: it renders in the count pill beside the section
// heading, which is where the console filter standard puts it.

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import type { AlertsBootstrap, DeliveryDTO } from "@/app/server/actions/alerts";
import { ActivityFilterBar } from "@/components/alerts/alerts-filter-bar";
import type { ActivityView } from "@/components/alerts/alerts-filters";
import { deliveryBadge } from "@/components/alerts/alerts-status";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { DataTable } from "@/components/data-table";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { formatDate } from "@repo/format";
import type { AssignedValue } from "@/lib/queries/classification";
import { StatusBadge } from "@repo/ui/status-badge";

/** Delivery activity log. */
export function ActivityPanel({
	bootstrap,
	view,
}: {
	bootstrap: AlertsBootstrap;
	/** The filter standard's resolved view — rows, facets, active-filter count. */
	view: ActivityView;
}) {
	const { deliveries } = bootstrap;
	// One batched query hydrates every delivery row's classification chips (read-only).
	const { data: classMap = {} } = useAssignmentsForKind(
		"alert_delivery",
		deliveries.map((d) => d.id),
	);
	const { rows, facets } = view;

	const columns = useMemo<ColumnDef<DeliveryDTO>[]>(
		() => buildColumns(classMap),
		[classMap],
	);

	return (
		<div>
			<ActivityFilterBar facets={facets} />

			<DataTable
				columns={columns}
				data={rows}
				emptyMessage="No activity matches these filters."
			/>
		</div>
	);
}

/**
 * The ledger's four columns, in the order the hand-rolled grid had them.
 *
 * `classMap` is a parameter rather than a closure over the component body so the column list
 * memoises on the one thing it actually depends on.
 */
function buildColumns(
	classMap: Record<string, AssignedValue[]>,
): ColumnDef<DeliveryDTO>[] {
	return [
		{
			accessorKey: "title",
			header: "Event",
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
							<div className="truncate text-[13px]">{d.title}</div>
							<div className="truncate font-mono text-[10.5px] text-muted-foreground">
								{d.event_key}
							</div>
							<ClassificationChips
								kind="alert_delivery"
								id={d.id}
								initialAssignments={classMap[d.id]}
								className="mt-1 flex"
							/>
							{d.last_error && (
								<div className="mt-1 break-words font-mono text-[10.5px] text-muted-foreground/70">
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
			// The dot in the Event cell already carries the tier; this column carries its word.
			cell: ({ row }) => (
				<span className="font-mono text-[11px] uppercase text-muted-foreground">
					{deliveryBadge(row.original.status).label}
				</span>
			),
		},
		{
			accessorKey: "attempts",
			header: "Attempts",
			cell: ({ row }) => (
				<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
					{row.original.attempts}
				</span>
			),
		},
		{
			accessorKey: "created_at",
			header: () => <div className="w-full text-right">When</div>,
			cell: ({ row }) => (
				<div className="text-right font-mono text-[10.5px] text-muted-foreground">
					{formatDate(row.original.created_at, "datetime")}
				</div>
			),
		},
	];
}
