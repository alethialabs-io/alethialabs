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

/** sessionStorage-persisted filter selections (search + authors/envs/projects/statuses/
 * types). `version: 2` adds `search` — the bump discards the older persisted shape rather
 * than shallow-merging it to a `search: undefined` that would uncontrol the search input. */
export const useJobsFilters = createFilterStore<JobsFilters>({
	name: "jobs-filters",
	defaults: DEFAULT_JOBS_FILTERS,
	version: 2,
});
