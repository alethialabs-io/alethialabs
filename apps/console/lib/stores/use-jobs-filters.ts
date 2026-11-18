// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs page's filter store — the console filter standard (#578): createFilterStore
// + URL sync (the page wires useFilterUrlSync). Replaces the orphaned use-jobs-store
// (whose single-value "All" filters matched nothing the page actually rendered).
// The date range deliberately stays OUT of the store — see components/jobs/jobs-query.ts.

import { createFilterStore } from "@/lib/stores/create-filter-store";
import {
	DEFAULT_JOBS_FILTERS,
	type JobsFilters,
} from "@/components/jobs/jobs-query";

/** Filter selections (search + authors/envs/projects/statuses/types) for the org jobs list and
 * every project's jobs list. One store backs all of them, so it is not persisted (#6814): the
 * pathname is its scope key, and the link is the only thing that carries a view from one visit
 * to the next. */
export const useJobsFilters = createFilterStore<JobsFilters>({
	name: "jobs-filters",
	defaults: DEFAULT_JOBS_FILTERS,
});
