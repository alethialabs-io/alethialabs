// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "My cases" filter store — the console filter standard's per-page state (see
// lib/query/README.md → "Server-side filters"). URL-synced by CaseList via
// useFilterUrlSync, and fed into qk.supportCases through normalizeSupportCaseQuery.

import {
	DEFAULT_SUPPORT_CASE_FILTERS,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Session-persisted filter selections for /~/support/my-cases. */
export const useSupportFilters = createFilterStore<SupportCaseFilters>({
	name: "support-case-filters",
	defaults: DEFAULT_SUPPORT_CASE_FILTERS,
	version: 1,
});
