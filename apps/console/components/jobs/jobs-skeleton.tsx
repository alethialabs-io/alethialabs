"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A CLIENT component, and both jobs routes' `loading.tsx` (server components) render it with one
// boolean prop, which is all that crosses the boundary. It has to be one: it renders the list's real
// filter bar, whose controls take handlers.

import { JobsFilterBar } from "@/components/jobs/jobs-filter-bar";
import { DEFAULT_JOBS_FILTERS } from "@/components/jobs/jobs-query";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { JOBS_DEFAULT_PRESET } from "@/lib/rpc/inputs/jobs";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { presetRange } from "@repo/ui/range";
import { useState } from "react";

/** A handler for a control nobody can reach: the skeleton is `inert`. */
function ignore() {}

/**
 * The loading form of the jobs list (`JobsClient`), in the order and the boxes it renders:
 *
 * - the toolbar — ONE line of description (no count: the list standard carries no list sizes);
 * - the filter bar — the list's OWN `JobsFilterBar`, at its defaults, inert and pulsing. Not bars of
 *   guessed widths: the bar wraps, and where it wraps is decided by the controls' real widths. The
 *   guessed version fit one line on a project's list where the page needs two, so the table landed
 *   46px below the skeleton's (#6350, B2 0.020);
 * - the table — Type, Status, Project (org route only), Runner, Environment, Initiated. It grows
 *   with the page, as the list's does (the keyset footer's scroll sentinel watches the viewport, so
 *   the list has no fixed-height scroll frame); the rows landing extend it downward and move
 *   nothing above or beside it.
 *
 * `showProject` is false on a project's own jobs route, which drops the Project facet and column
 * exactly as `JobsClient` does when given a `projectId`.
 */
export function JobsListSkeleton({ showProject = true }: { showProject?: boolean }) {
	// Resolved once: the date control prints a placeholder until it has mounted, so the instant does
	// not reach the server's markup.
	const [range] = useState(() => presetRange(JOBS_DEFAULT_PRESET));
	return (
		<div className="space-y-6" aria-busy inert data-slot="jobs-list-skeleton">
			<PageToolbarSkeleton />
			<JobsFilterBar
				className="animate-pulse"
				showProject={showProject}
				filters={DEFAULT_JOBS_FILTERS}
				onFilter={ignore}
				onReset={ignore}
				range={range}
				authorOptions={[]}
				authorsLoading={false}
				facets={undefined}
				onCreateProject={ignore}
			/>
			<DataTableSkeleton columns={showProject ? 6 : 5} rows={11} />
		</div>
	);
}
