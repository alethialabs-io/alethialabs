// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's filter stores — the console filter standard's per-page state (see
// lib/query/README.md → "Server-side filters"). The hub stacks three surfaces on ONE
// route, so it gets three stores rather than one: each panel filters an independent
// universe with its own facets, and a shared bag would make "Reset" on one panel wipe
// the other two.
//
// Because they share a URL, their search params are prefixed (channel* / policy* /
// activity*) where useFilterUrlSync is wired up in components/alerts/alerts-filters.ts —
// an unprefixed `search` from three stores would collide.

import {
	type ActivityFilters,
	type ChannelFilters,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	type PolicyFilters,
} from "@/components/alerts/alerts-query";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Session-persisted filter selections for the Alerts hub's Policies panel. */
export const useAlertPolicyFilters = createFilterStore<PolicyFilters>({
	name: "alert-policy-filters",
	defaults: DEFAULT_POLICY_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for the Alerts hub's Channels panel. */
export const useAlertChannelFilters = createFilterStore<ChannelFilters>({
	name: "alert-channel-filters",
	defaults: DEFAULT_CHANNEL_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for the Alerts hub's Activity ledger. */
export const useAlertActivityFilters = createFilterStore<ActivityFilters>({
	name: "alert-activity-filters",
	defaults: DEFAULT_ACTIVITY_FILTERS,
	version: 1,
});
