// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service tokens list's filter store — the console filter standard's per-page state
// (lib/query/README.md → "Server-side filters"). URL-synced by ServiceTokensPage through
// useFilterUrlSync, and fed into `agents.serviceTokens` through normalizeServiceTokensQuery. Its own
// module rather than a seventh store in use-settings-filters.ts, so this lane edits no shared file.

import {
	DEFAULT_SERVICE_TOKEN_FILTERS,
	type ServiceTokenFilters,
} from "@/components/settings/tokens/tokens-filters";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Filter selections for /~/settings/tokens. Remembers nothing: the URL is its only memory. */
export const useServiceTokenFilters = createFilterStore<ServiceTokenFilters>({
	name: "settings-service-token-filters",
	defaults: DEFAULT_SERVICE_TOKEN_FILTERS,
});
