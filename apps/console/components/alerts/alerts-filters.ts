"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's filter pipeline — the console filter standard end to end for the three
// panels (lib/query/README.md → "Server-side filters"):
//
//   store (use-alerts-filters) → useFilterUrlSync → useDebouncedValue → normalize*Query()
//     → qk.alert*(org, query) → getAlert*Page(query)
//
// The resolve step USED to be in-memory (`filter*()` from alerts-query.ts), because the alerts
// route is RSC-fed and `getAlertsBootstrap()` returned the whole universe in one payload. This
// file recorded that deviation against itself; #4890 closed it. The three server-side siblings
// have existed since #2899 and nothing called them, so every filtered view of a panel shared one
// cache entry and the ledger's filter could only ever see the newest 50 rows.
//
// Each hook is called ONCE, from alerts-page.tsx, which owns the resolved view and hands it to
// the panels — so the URL-sync effects mount once even though the panels' filter bars read the
// same stores. The three stores share a URL, hence the param prefixes below.
//
// The CHIP labels stay here rather than coming off the wire. `orderedOptions()` in
// lib/queries/facets.ts labels an option only when the builder hands it a `labelOf`, and for the
// four chip dimensions below it does not — the human strings are client constants
// (alerts-query.ts) that alerts-status.ts already reads for the same values. Resolving them here
// keeps ONE source for "what the user calls this status", which is the whole reason the label
// maps are not in the database.

import { useMemo } from "react";
import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import {
	CHANNEL_STATUS_LABEL,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	DELIVERY_STATUS_LABEL,
	type FacetCount,
	normalizeActivityQuery,
	normalizeChannelsQuery,
	normalizePoliciesQuery,
	POLICY_KIND_LABEL,
	POLICY_STATUS_LABEL,
} from "@/components/alerts/alerts-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { FacetOption } from "@/lib/queries/facets";
import {
	useAlertChannelsPageQuery,
	useAlertDeliveriesPageQuery,
	useAlertPoliciesPageQuery,
} from "@/lib/query/use-alerts-query";
import {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";
import { lookup } from "@/lib/typed-object";

const SEARCH_DEBOUNCE = 300;

/** What a panel needs to render: the resolved rows, the facets behind its bar, and staleness. */
export interface FilteredView<Row, Facets> {
	/** Rows matching the current (debounced, normalized) query, as the SERVER resolved them. */
	rows: Row[];
	/** How many rows matched — the count pill's figure. */
	count: number;
	/** Facet options + counts over the UNFILTERED universe. */
	facets: Facets;
	/**
	 * True while these rows are the PREVIOUS query's answer, held across a filter change by
	 * `keepPreviousData`. The panel dims them; keeping a stale list without saying it is stale
	 * renders the previous filter's answer as the current one.
	 */
	stale: boolean;
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

/**
 * Server facet options as the filter bars' `FacetCount`s, with the human label resolved.
 *
 * `labels` is consulted first and the raw value is the fallback, so a value the client's label
 * map has not heard of renders as itself rather than as an empty chip.
 */
function labelled(
	options: FacetOption[],
	labels: Record<string, string> = {},
): FacetCount[] {
	return options.map((o) => ({
		value: o.value,
		label: o.label ?? lookup(labels, o.value) ?? o.value,
		count: o.count,
	}));
}

/** The empty facet set a panel renders against while its first read is in flight. */
const NO_OPTIONS: FacetOption[] = [];

/** Channels: URL-synced, debounced filters resolved by `getAlertChannelsPage(query)`.
 *  @param enabled false on the hub's upsell path, where no list renders. */
export function useChannelsView(enabled = true): ChannelsView {
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
	const page = useAlertChannelsPageQuery(query, enabled);
	const facets = useMemo(
		() => ({
			types: labelled(page.data?.facets.types ?? NO_OPTIONS),
			status: labelled(
				page.data?.facets.status ?? NO_OPTIONS,
				CHANNEL_STATUS_LABEL,
			),
		}),
		[page.data],
	);
	return {
		rows: page.data?.rows ?? [],
		count: page.data?.resultCount ?? 0,
		facets,
		stale: page.isPlaceholderData,
	};
}

/** Policies: URL-synced, debounced filters resolved by `getAlertPoliciesPage(query)`.
 *  @param enabled see {@link useChannelsView}. */
export function usePoliciesView(enabled = true): PoliciesView {
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
	const page = useAlertPoliciesPageQuery(query, enabled);
	const facets = useMemo(
		() => ({
			status: labelled(
				page.data?.facets.status ?? NO_OPTIONS,
				POLICY_STATUS_LABEL,
			),
			kinds: labelled(page.data?.facets.kinds ?? NO_OPTIONS, POLICY_KIND_LABEL),
			channels: labelled(page.data?.facets.channels ?? NO_OPTIONS),
		}),
		[page.data],
	);
	return {
		rows: page.data?.rows ?? [],
		count: page.data?.resultCount ?? 0,
		facets,
		stale: page.isPlaceholderData,
	};
}

/** Activity: URL-synced, debounced filters resolved by `getAlertDeliveriesPage(query)`.
 *  @param enabled see {@link useChannelsView}. */
export function useActivityView(enabled = true): ActivityView {
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
	const page = useAlertDeliveriesPageQuery(query, enabled);
	const facets = useMemo(
		() => ({
			status: labelled(
				page.data?.facets.status ?? NO_OPTIONS,
				DELIVERY_STATUS_LABEL,
			),
		}),
		[page.data],
	);
	return {
		rows: page.data?.rows ?? [],
		count: page.data?.resultCount ?? 0,
		facets,
		stale: page.isPlaceholderData,
	};
}
