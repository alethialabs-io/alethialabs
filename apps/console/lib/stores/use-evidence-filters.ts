// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence page's filter store — the console filter standard's per-page state
// (see lib/query/README.md → "Server-side filters"). URL-synced by the page client
// via useFilterUrlSync; fed into qk.evidence through normalizeEvidenceQuery.

import {
	DEFAULT_EVIDENCE_FILTERS,
	type EvidenceFilters,
} from "@/components/evidence/evidence-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Session-persisted filter selections for /~/evidence. */
export const useEvidenceFilters = createFilterStore<EvidenceFilters>({
	name: "evidence-filters",
	defaults: DEFAULT_EVIDENCE_FILTERS,
	version: 1,
});
