// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter stores for every Settings list surface — the console filter standard's per-page
// state (see lib/query/README.md → "Server-side filters"). Each one is URL-synced by its page
// via `useFilterUrlSync` and fed, debounced and normalized, into a parameterized `qk.*` key.
//
// Seven stores share one module deliberately. Before this, six settings surfaces carried
// forty-plus `useState` calls between them — nine on the activity log, eleven on the SSO
// manager, fifteen on Access — each re-deriving the same debounce/reset/persist behaviour by
// hand and none of them shareable by URL. Splitting them into one-export files would have
// been seven near-identical files; the FILTER SHAPES live next to the surfaces that own them
// (`components/settings/*/*-filters.ts`, mirroring `components/evidence/evidence-query.ts`),
// and only the store wiring is collected here.
//
// NONE of them persists (#6814). Every one of these routes prefetches its first page from the
// link's filters, and each store is shared: by every org a tab visits, and Access and Activity
// by an org page and a project page as well. So the URL is each store's only memory, and
// `useFilterUrlSync` replaces the store with the link's view on mount. `name` still identifies
// the store; it would be the sessionStorage key prefix if one were ever built with
// `persist: true`.

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

/** Filter selections for /~/settings/activity (and the project feed). The first store to drop
 * session persistence (#6320); the factory's default since #6814. */
export const useActivityFilters = createFilterStore<ActivityFilters>({
	name: "settings-activity-filters",
	defaults: DEFAULT_ACTIVITY_FILTERS,
});

/** Filter selections for /~/settings/sso. */
export const useSsoFilters = createFilterStore<SsoFilters>({
	name: "settings-sso-filters",
	defaults: DEFAULT_SSO_FILTERS,
});

/** Filter selections for /~/settings/roles. */
export const useRolesFilters = createFilterStore<RolesFilters>({
	name: "settings-roles-filters",
	defaults: DEFAULT_ROLES_FILTERS,
});

/** Filter selections for /~/settings/billing/invoices. The time window is the one `range` key
 * (#6731). */
export const useInvoiceFilters = createFilterStore<InvoiceFilters>({
	name: "settings-invoice-filters",
	defaults: DEFAULT_INVOICE_FILTERS,
});

/** Filter selections for /~/settings/access (and the project surface). */
export const useAccessFilters = createFilterStore<AccessFilters>({
	name: "settings-access-filters",
	defaults: DEFAULT_ACCESS_FILTERS,
});

/** Filter selections for /~/settings/teams. */
export const useTeamsFilters = createFilterStore<TeamsFilters>({
	name: "settings-teams-filters",
	defaults: DEFAULT_TEAMS_FILTERS,
});

/** Filter selections for /~/settings/members. */
export const useMembersFilters = createFilterStore<MembersFilters>({
	name: "settings-members-filters",
	defaults: DEFAULT_MEMBERS_FILTERS,
});
