// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's filter store — the console filter standard (#578):
// createFilterStore + URL sync + debounced search. See lib/query/README.md
// → "Server-side filters (the standard)"; evidence is the reference.

import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Active filter selections for the runners grid (a type alias, not an interface, so it
 * satisfies the store factory's Record constraint). Empty = "no filter". */
export type RunnerPageFilters = {
	search: string;
	clouds: string[];
	statuses: string[];
	operators: string[];
	regions: string[];
	versions: string[];
};

/** The default (empty) filter set — the store's initial state and the Reset target. */
export const DEFAULT_RUNNER_FILTERS: RunnerPageFilters = {
	search: "",
	clouds: [],
	statuses: [],
	operators: [],
	regions: [],
	versions: [],
};

/** sessionStorage-persisted, URL-synced by the page via useFilterUrlSync. */
export const useRunnerFilters = createFilterStore<RunnerPageFilters>({
	name: "runner-filters",
	defaults: DEFAULT_RUNNER_FILTERS,
	version: 1,
});
