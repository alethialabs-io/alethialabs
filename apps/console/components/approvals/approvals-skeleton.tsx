"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/**
 * The loading form of the approvals list, in the boxes it renders: the one-row `ListToolbar` (a
 * search and the four facets: Status, Operation, Requested through, Environment; no count and no
 * description) and the table with its six columns. Synchronous: it reads nothing.
 */
export function ApprovalsSkeleton() {
	return (
		<SkeletonRoot className="space-y-6" data-skeleton="approvals" inert>
			<ListToolbarSkeleton facets={4} />
			<DataTableSkeleton columns={6} rows={6} />
		</SkeletonRoot>
	);
}
