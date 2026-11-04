// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's loading shapes (#6125, RUBRIC B2). One file so the route's skeleton and each
// panel's own pending render are the same shapes as the hub they stand in for: a SectionHeading row
// (title + one description line, Docs on the right), the panel's filter bar, then a policy/channel
// master-detail — the rail beside the detail — or the Activity ledger's four-column table.
//
// No "use client": the route renders it as its `<Suspense>` fallback from the server, and the panels
// render it from the client.

import { Skeleton } from "@repo/ui/skeleton";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/** Which of the hub's three bodies a skeleton stands in for. */
export type AlertsPanelKind = "policies" | "channels" | "activity";

/** The filter bar row: the search field and its chips, and (on a master-detail) the add button. */
function FilterBarSkeleton({ action }: { action: boolean }) {
	return (
		<div className="mb-4 flex flex-wrap items-center gap-2.5">
			<Skeleton className="h-8 w-56 rounded-md" />
			<Skeleton className="h-8 w-24 rounded-md" />
			<Skeleton className="h-8 w-24 rounded-md" />
			{action && <Skeleton className="ml-auto h-8 w-28 rounded-md" />}
		</div>
	);
}

/**
 * One panel's body while its read is pending: the filter bar and the master-detail (or, for
 * Activity, the ledger table) at the sizes they render. Never the panel's empty copy — a read that
 * has not answered has not said there is nothing.
 */
export function AlertsPanelSkeleton({ kind }: { kind: AlertsPanelKind }) {
	if (kind === "activity") {
		return (
			<div aria-hidden data-slot="alerts-panel-skeleton">
				<FilterBarSkeleton action={false} />
				<DataTableSkeleton columns={4} rows={5} />
			</div>
		);
	}
	return (
		<div aria-hidden data-slot="alerts-panel-skeleton">
			<FilterBarSkeleton action />
			<div className="flex flex-wrap items-start gap-4">
				<div className="min-w-[290px] flex-1 overflow-hidden rounded-xl border border-border/60">
					<div className="px-4 py-3">
						<Skeleton className="h-3 w-20" />
					</div>
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex items-center gap-3 border-t border-border/60 px-3.5 py-3">
							<Skeleton className="size-8 rounded-md" />
							<div className="flex-1 space-y-1.5">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-3 w-24" />
							</div>
						</div>
					))}
				</div>
				<Skeleton className="h-80 min-w-[min(500px,100%)] flex-[100] rounded-xl" />
			</div>
		</div>
	);
}

/** One section's heading row: the icon tile and title, one description line, Docs on the right. */
function SectionHeadingSkeleton() {
	return (
		<div className="mb-4 flex items-start justify-between gap-4">
			<div className="space-y-2">
				<Skeleton className="h-7 w-36" />
				<Skeleton className="h-4 w-80 max-w-full" />
			</div>
			<Skeleton className="h-7 w-16 rounded-md" />
		</div>
	);
}

/**
 * The whole hub while its reads are prefetched on the server — the route's `<Suspense>` fallback.
 * Rendered only once the route has decided the org is entitled and the viewer may see alerts, so it
 * never promises a hub to someone who will get the upsell or the no-access notice (F021).
 */
export function AlertsSkeleton() {
	return (
		<div className="space-y-12" role="status" aria-busy="true">
			<span className="sr-only">Loading alerts</span>
			{(["policies", "channels", "activity"] as const).map((kind) => (
				<section key={kind}>
					<SectionHeadingSkeleton />
					<AlertsPanelSkeleton kind={kind} />
				</section>
			))}
		</div>
	);
}
