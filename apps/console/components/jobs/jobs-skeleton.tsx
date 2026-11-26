"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Both jobs routes' `loading.tsx` (server components) render it with one boolean prop, which is all
// that crosses the boundary.

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/**
 * The loading form of the jobs list (`JobsClient`), in the order and the boxes it renders:
 *
 * - the one-row `ListToolbar` — the search, one placeholder per facet (Author, Environment, Project
 *   on the org route only, Status, Type) and the range. No count (the list standard carries no list
 *   sizes) and no description line (polish-wave spec §3, #7738);
 * - the table — Type, Status, Project (org route only), Runner, Environment, Initiated. It grows
 *   with the page, as the list's does (the keyset footer's scroll sentinel watches the viewport, so
 *   the list has no fixed-height scroll frame); the rows landing extend it downward and move
 *   nothing above or beside it.
 *
 * `showProject` is false on a project's own jobs route, which drops the Project facet and column
 * exactly as `JobsClient` does when given a `projectId`.
 */
export function JobsListSkeleton({ showProject = true }: { showProject?: boolean }) {
	return (
		<div className="space-y-6" aria-busy inert data-slot="jobs-list-skeleton">
			<ListToolbarSkeleton facets={showProject ? 5 : 4} dateRange />
			<DataTableSkeleton columns={showProject ? 6 : 5} rows={11} />
		</div>
	);
}
