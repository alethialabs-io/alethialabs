"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { ApprovalsFilterBar } from "./approvals-filter-bar";
import { DEFAULT_APPROVALS_FILTERS } from "./approvals-query";

/** A handler for a control nobody can reach: the skeleton is inert. */
function ignore() {}

/**
 * The loading form of the approvals list, in the boxes it renders: the toolbar's description (no
 * count — there is none), the list's OWN filter bar at its defaults so it wraps where the real one
 * does, and the table with its six columns. Synchronous: it reads nothing.
 */
export function ApprovalsSkeleton() {
	return (
		<SkeletonRoot className="space-y-6" data-skeleton="approvals" inert>
			<PageToolbarSkeleton description />
			<ApprovalsFilterBar filters={DEFAULT_APPROVALS_FILTERS} onFilter={ignore} onReset={ignore} facets={undefined} />
			<DataTableSkeleton columns={6} rows={6} />
		</SkeletonRoot>
	);
}
