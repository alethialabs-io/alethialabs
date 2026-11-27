// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for Settings · Billing · Invoices.
 *
 * Without this file the route inherited `../loading.tsx` — the BILLING panel's skeleton, which is a
 * plan card and a few content lines, not a filtered table. Mirrors what this page renders: the back
 * link, then `InvoicesPanel` — its `SettingsSection` heading row (the title and the hairline rule, no
 * count beside it), its `ListToolbar` (no search; the Status facet, then the quick range and the
 * date range it passes as `extra`), then the invoice rows. The toolbar is `ListToolbarSkeleton`, so
 * it is built from the real row's own layout classes.
 */
export default function InvoicesLoading() {
	return (
		<div>
			{/* ← Billing */}
			<Skeleton className="mb-4 h-4 w-20" />

			<div className="mb-[18px]">
				{/* `SettingsSection`'s heading row: the "Invoices" title and the rule after it. */}
				<div className="mb-3 flex items-center gap-3">
					<Skeleton className="h-4 w-24" />
					<span className="h-px flex-1 bg-border" />
				</div>

				<ListToolbarSkeleton search={false} facets={1} extra={["control", "control"]} />

				<DataTableSkeleton columns={6} rows={8} />
			</div>
		</div>
	);
}
