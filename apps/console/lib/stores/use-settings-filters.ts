// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter stores for every Settings list surface — the console filter standard's per-page
// state (see lib/query/README.md → "Server-side filters"). Each one is URL-synced by its page
// via `useFilterUrlSync` and fed, debounced and normalized, into a parameterized `qk.*` key.
//
// Six stores share one module deliberately. Before this, six settings surfaces carried
// forty-plus `useState` calls between them — nine on the activity log, eleven on the SSO
// manager, fifteen on Access — each re-deriving the same debounce/reset/persist behaviour by
// hand and none of them shareable by URL. Splitting them into six one-export files would have
// been six near-identical files; the FILTER SHAPES live next to the surfaces that own them
// (`components/settings/*/*-filters.ts`, mirroring `components/evidence/evidence-query.ts`),
// and only the store wiring is collected here.
//
// The `name` of each store is its sessionStorage key and must stay unique across the console.
// Bump a store's `version` whenever its filter shape changes, so a previously persisted shape
// cannot rehydrate into fields that no longer exist.

import {
	DEFAULT_ACCESS_FILTERS,
	type AccessFilters,
} from "@/components/settings/access/access-filters";
import {
	DEFAULT_ACTIVITY_FILTERS,
	type ActivityFilters,
} from "@/components/settings/activity/activity-filters";
import {
	DEFAULT_INVOICE_FILTERS,
	type InvoiceFilters,
} from "@/components/settings/billing/invoices-filters";
import {
	DEFAULT_MEMBERS_FILTERS,
	type MembersFilters,
} from "@/components/settings/members/members-filters";
import {
	DEFAULT_ROLES_FILTERS,
	type RolesFilters,
} from "@/components/settings/roles/roles-filters";
import {
	DEFAULT_SSO_FILTERS,
	type SsoFilters,
} from "@/components/settings/sso/sso-filters";
import {
	DEFAULT_TEAMS_FILTERS,
	type TeamsFilters,
} from "@/components/settings/teams/teams-filters";
import { createFilterStore } from "@/lib/stores/create-filter-store";

/** Session-persisted filter selections for /~/settings/activity (and the project feed). */
export const useActivityFilters = createFilterStore<ActivityFilters>({
	name: "settings-activity-filters",
	defaults: DEFAULT_ACTIVITY_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/sso. */
export const useSsoFilters = createFilterStore<SsoFilters>({
	name: "settings-sso-filters",
	defaults: DEFAULT_SSO_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/roles. */
export const useRolesFilters = createFilterStore<RolesFilters>({
	name: "settings-roles-filters",
	defaults: DEFAULT_ROLES_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/billing/invoices. */
export const useInvoiceFilters = createFilterStore<InvoiceFilters>({
	name: "settings-invoice-filters",
	defaults: DEFAULT_INVOICE_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/access (and the project surface). */
export const useAccessFilters = createFilterStore<AccessFilters>({
	name: "settings-access-filters",
	defaults: DEFAULT_ACCESS_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/teams. */
export const useTeamsFilters = createFilterStore<TeamsFilters>({
	name: "settings-teams-filters",
	defaults: DEFAULT_TEAMS_FILTERS,
	version: 1,
});

/** Session-persisted filter selections for /~/settings/members. */
export const useMembersFilters = createFilterStore<MembersFilters>({
	name: "settings-members-filters",
	defaults: DEFAULT_MEMBERS_FILTERS,
	version: 1,
});
