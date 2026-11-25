// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approvals list's filter store — the console filter standard: createFilterStore + URL sync (the
// page wires useFilterUrlSync). Not persisted (#6814): the link is the only memory, so the route can
// prefetch exactly what the first paint shows.

import { createFilterStore } from "@/lib/stores/create-filter-store";
import { type ApprovalsFilters, DEFAULT_APPROVALS_FILTERS } from "@/components/approvals/approvals-query";

/** Filter selections for `/{org}/~/approvals`: search, status (Waiting by default), operation, credential, environment. */
export const useApprovalsFilters = createFilterStore<ApprovalsFilters>({
	name: "approvals-filters",
	defaults: DEFAULT_APPROVALS_FILTERS,
});
