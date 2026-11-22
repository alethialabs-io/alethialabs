// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's filter store — the console filter standard: createFilterStore + URL sync
// + debounced search. See lib/query/README.md → "Server-side filters (the standard)".

import {
	DEFAULT_ENVIRONMENT_FILTERS,
	type EnvironmentPageFilters,
} from "@/components/environments/environments-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/**
 * One store for every `/{org}/{project}/environments`: the page's pathname is its scope key
 * (`useFilterUrlSync` enters it), so a selection made in one project never shows in another. It
 * remembers nothing; the URL is its memory. The filter shape, its defaults and the normalize step
 * live in components/environments/environments-query.ts.
 */
export const useEnvironmentsFilters = createFilterStore<EnvironmentPageFilters>({
	name: "environments-filters",
	defaults: DEFAULT_ENVIRONMENT_FILTERS,
	version: 1,
});
