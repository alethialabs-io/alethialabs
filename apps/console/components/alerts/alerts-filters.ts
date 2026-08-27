"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's filter pipeline — the console filter standard end to end for the three
// panels (lib/query/README.md → "Server-side filters"):
//
//   store (use-alerts-filters) → useFilterUrlSync → useDebouncedValue → normalize*Query()
//     → the resolve step
//
// The resolve step is in-memory (`filter*()` from alerts-query.ts) because the alerts route
// is RSC-fed: `getAlertsBootstrap()` returns the whole universe in one payload and has no
// filtered sibling, and both live outside this lane's scope. The normalized objects are
// exactly what `qk.alertChannels(org, q)` / `qk.alertPolicies(org, q)` are shaped to key,
// so the swap to a server action is `filterChannels(...)` → `queryFn: () => getChannels(q)`.
//
// Each hook is called ONCE, from alerts-page.tsx, which owns the resolved view and hands it
// to the panels — so the URL-sync effects mount once even though the panels' filter bars
// read the same stores. The three stores share a URL, hence the param prefixes below.

import { useMemo } from "react";
import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import {
	activityFacets,
	channelFacets,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	type FacetCount,
	filterChannels,
	filterDeliveries,
	filterPolicies,
	normalizeActivityQuery,
	normalizeChannelsQuery,
	normalizePoliciesQuery,
	policyFacets,
} from "@/components/alerts/alerts-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";

const SEARCH_DEBOUNCE = 300;

/** What a panel needs to render: the resolved rows and the facets behind its bar. */
export interface FilteredView<Row, Facets> {
	/** Rows matching the current (debounced, normalized) query. */
	rows: Row[];
	/** Facet options + counts over the UNFILTERED universe. */
	facets: Facets;
}

export type ChannelsView = FilteredView<
	ChannelDTO,
	{ types: FacetCount[]; status: FacetCount[] }
>;

export type PoliciesView = FilteredView<
	PolicyDTO,
	{ status: FacetCount[]; kinds: FacetCount[]; channels: FacetCount[] }
>;

export type ActivityView = FilteredView<DeliveryDTO, { status: FacetCount[] }>;

/** Channels: URL-synced filters resolved against the bootstrap's channel universe. */
export function useChannelsView(channels: ChannelDTO[]): ChannelsView {
	const filters = useAlertChannelFilters((s) => s.filters);
	useFilterUrlSync(useAlertChannelFilters, DEFAULT_CHANNEL_FILTERS, {
		search: "channel",
		types: "channelType",
		status: "channelStatus",
	});
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE);
	const query = useMemo(
		() => normalizeChannelsQuery({ ...filters, search }),
		[filters, search],
	);
	const rows = useMemo(() => filterChannels(channels, query), [channels, query]);
	const facets = useMemo(() => channelFacets(channels), [channels]);
	return { rows, facets };
}

/** Policies: URL-synced filters resolved against the bootstrap's policy universe. */
export function usePoliciesView(
	policies: PolicyDTO[],
	channels: ChannelDTO[],
): PoliciesView {
	const filters = useAlertPolicyFilters((s) => s.filters);
	useFilterUrlSync(useAlertPolicyFilters, DEFAULT_POLICY_FILTERS, {
		search: "policy",
		status: "policyStatus",
		kinds: "policyKind",
		channels: "policyChannel",
	});
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE);
	const query = useMemo(
		() => normalizePoliciesQuery({ ...filters, search }),
		[filters, search],
	);
	const rows = useMemo(() => filterPolicies(policies, query), [policies, query]);
	const facets = useMemo(
		() => policyFacets(policies, channels),
		[policies, channels],
	);
	return { rows, facets };
}

/** Activity: URL-synced filters resolved against the bootstrap's delivery ledger. */
export function useActivityView(deliveries: DeliveryDTO[]): ActivityView {
	const filters = useAlertActivityFilters((s) => s.filters);
	useFilterUrlSync(useAlertActivityFilters, DEFAULT_ACTIVITY_FILTERS, {
		search: "activity",
		status: "activityStatus",
	});
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE);
	const query = useMemo(
		() => normalizeActivityQuery({ ...filters, search }),
		[filters, search],
	);
	const rows = useMemo(
		() => filterDeliveries(deliveries, query),
		[deliveries, query],
	);
	const facets = useMemo(() => activityFacets(deliveries), [deliveries]);
	return { rows, facets };
}
