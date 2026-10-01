// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's filter store — the console filter standard (#578):
// createFilterStore + URL sync + debounced search. See lib/query/README.md
// → "Server-side filters (the standard)"; evidence is the reference.

import {
	DEFAULT_RUNNER_FILTERS,
	type RunnerPageFilters,
} from "@/components/runners/runners-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** sessionStorage-persisted, URL-synced by the page via useFilterUrlSync. The filter shape,
 * its defaults and the normalize step live in components/runners/runners-query.ts. */
export const useRunnerFilters = createFilterStore<RunnerPageFilters>({
	name: "runner-filters",
	defaults: DEFAULT_RUNNER_FILTERS,
	version: 1,
});
