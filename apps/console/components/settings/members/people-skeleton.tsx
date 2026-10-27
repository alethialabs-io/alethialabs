// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the people & access routes' `loading.tsx` render this, and they are server
// components.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/**
 * The loading form of a people & access list (members, teams, access), in the order and the boxes
 * the page renders (#6129, RUBRIC B2):
 *
 * - the toolbar — a result count, ONE line of description, and `actions` buttons;
 * - the filter bar — the search box (`w-[240px] max-w-[380px] flex-1`, as every one of these
 *   pages sizes it) and one `h-8` control per facet;
 * - the table, with the real table's column count.
 *
 * `lead` draws a block above the toolbar — the Access page's inheritance note, which it renders
 * whatever the entitlement.
 */
export function PeopleListSkeleton({
	facets,
	columns,
	actions = 1,
	rows = 6,
	lead = false,
}: {
	facets: number;
	columns: number;
	actions?: number;
	rows?: number;
	lead?: boolean;
}) {
	return (
		<div aria-busy>
			{lead && <Skeleton className="mb-[18px] h-[74px] w-full rounded-lg" />}
			<PageToolbarSkeleton className="mb-4" count actions={actions} />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-md" />
				{Array.from({ length: facets }, (_, i) => (
					<Skeleton key={i} className="h-8 w-28 rounded-md" />
				))}
			</div>
			<DataTableSkeleton columns={columns} rows={rows} />
		</div>
	);
}
