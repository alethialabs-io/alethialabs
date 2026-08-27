// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's filter store — the console filter standard's per-page state
// (see lib/query/README.md → "Server-side filters"). URL-synced by the page client via
// useFilterUrlSync; fed into qk.connectors through normalizeConnectorQuery.
//
// It replaces a `useState` group filter driven by a Radix <Select> (banned from filter
// bars) plus a `useState` search box, neither of which survived a navigation or a paste
// of the page's own URL.

import {
	DEFAULT_CONNECTOR_FILTERS,
	type ConnectorFilters,
} from "@/components/connectors/connectors-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Session-persisted filter selections for /{org}/~/connectors. */
export const useConnectorFilters = createFilterStore<ConnectorFilters>({
	name: "connector-filters",
	defaults: DEFAULT_CONNECTOR_FILTERS,
	version: 1,
});
