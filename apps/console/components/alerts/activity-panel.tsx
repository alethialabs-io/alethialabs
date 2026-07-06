"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub · Activity panel (ported from the Alethia Labs design "alerts-hub").
// The durable delivery ledger: a status filter segment + a table. Bound to the real
// DeliveryDTO (event/status/attempts/when/error) — the design's per-policy and
// per-channel columns aren't in the DTO yet, so they're omitted.

import { useState } from "react";
import type { AlertsBootstrap, DeliveryDTO } from "@/app/server/actions/alerts";
import type { AlertDeliveryStatus } from "@/lib/db/schema/enums";
import { cn } from "@repo/ui/utils";

type Filter = "all" | "delivered" | "failed";

const STATUS_LABEL: Record<AlertDeliveryStatus, string> = {
	pending: "Pending",
	sent: "Sent",
	failed: "Failed",
	dead: "Dead",
};

function isFailed(d: DeliveryDTO): boolean {
	return d.status === "failed" || d.status === "dead";
}

/** Delivery activity log. */
export function ActivityPanel({ bootstrap }: { bootstrap: AlertsBootstrap }) {
	const { deliveries } = bootstrap;
	const [filter, setFilter] = useState<Filter>("all");

	const rows = deliveries.filter((d) => {
		if (filter === "failed") return isFailed(d);
		if (filter === "delivered") return d.status === "sent";
		return true;
	});

	return (
		<div>
			{/* toolbar */}
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="inline-flex gap-0.5 rounded-md border border-border bg-muted/30 p-[3px]">
					{(["all", "delivered", "failed"] as const).map((f) => (
						<button
							key={f}
							type="button"
							onClick={() => setFilter(f)}
							className={cn(
								"rounded px-3 py-1.5 font-medium text-[12.5px] capitalize transition-colors",
								filter === f
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{f}
						</button>
					))}
				</div>
				<span className="font-mono text-[11px] text-muted-foreground">
					{rows.length} of {deliveries.length} events
				</span>
			</div>

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
						No matching activity.
					</div>
				) : (
					rows.map((d) => (
						<div
							key={d.id}
							className="grid grid-cols-[2fr_1fr_auto_1.2fr] items-center gap-4 border-b border-border px-5 py-3 last:border-b-0 hover:bg-muted/30"
						>
							<div className="flex min-w-0 items-center gap-3">
								<span
									className={cn(
										"h-2 w-2 flex-none rounded-full",
										isFailed(d)
											? "bg-foreground shadow-[inset_0_0_0_2.5px_var(--color-card)]"
											: "bg-foreground",
									)}
								/>
								<div className="min-w-0">
									<div className="truncate text-[13px]">{d.title}</div>
									<div className="truncate font-mono text-[10.5px] text-muted-foreground">
										{d.event_key}
									</div>
								</div>
							</div>
							<div className="font-mono text-[11px] uppercase text-muted-foreground">
								{STATUS_LABEL[d.status]}
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
