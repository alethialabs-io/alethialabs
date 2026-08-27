"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Activity panel (ported from the Alethia Labs design "alerts-hub").
// The durable delivery ledger: the standard filter bar (search + delivery-status chips,
// see alerts-filter-bar.tsx) over a table. Bound to the real DeliveryDTO
// (event/status/attempts/when/error) — the design's per-policy and per-channel columns
// aren't in the DTO yet, so they're omitted.
//
// The result count is NOT in the bar: it renders in the count pill beside the section
// heading, which is where the console filter standard puts it.

import type { AlertsBootstrap } from "@/app/server/actions/alerts";
import { ActivityFilterBar } from "@/components/alerts/alerts-filter-bar";
import type { ActivityView } from "@/components/alerts/alerts-filters";
import { deliveryBadge } from "@/components/alerts/alerts-status";
import { ClassificationChips } from "@/components/classification/classification-chips";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
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

	return (
		<div>
			<ActivityFilterBar facets={facets} />

			{/* table */}
			<div className="overflow-hidden rounded-lg border border-border shadow-sm">
				<div className="grid grid-cols-[2fr_1fr_auto_1.2fr] gap-4 border-b border-border bg-muted/30 px-5 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
					<span>Event</span>
					<span>Status</span>
					<span>Attempts</span>
					<span className="text-right">When</span>
				</div>
				{rows.length === 0 ? (
					<div className="px-5 py-8 text-center text-muted-foreground/70 text-sm">
						No activity matches these filters.
					</div>
				) : (
					rows.map((d) => (
						<div
							key={d.id}
							className="grid grid-cols-[2fr_1fr_auto_1.2fr] items-center gap-4 border-b border-border px-5 py-3 last:border-b-0 hover:bg-muted/30"
						>
							<div className="flex min-w-0 items-center gap-3">
								<StatusBadge
									{...deliveryBadge(d.status)}
									showLabel={false}
									className="shrink-0"
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
								</div>
							</div>
							{/* The dot already carries the tier; the column carries only its word. */}
							<div className="font-mono text-[11px] uppercase text-muted-foreground">
								{deliveryBadge(d.status).label}
							</div>
							<div className="font-mono text-[11px] text-muted-foreground">
								{d.attempts}
							</div>
							<div className="text-right font-mono text-[10.5px] text-muted-foreground">
								{new Date(d.created_at).toLocaleString()}
							</div>
							{d.last_error && (
								<div className="col-span-full -mt-1 truncate font-mono text-[10.5px] text-muted-foreground/70">
									{d.last_error}
								</div>
							)}
						</div>
					))
				)}
			</div>
		</div>
	);
}
