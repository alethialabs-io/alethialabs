"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Activity panel's view: the delivery ledger as a KEYSET list (lib/query/README.md → "Paging";
// epic #7481, LST-7 #7489). The same filter pipeline as its two siblings in ./alerts-filters.ts —
// store → useFilterUrlSync → useDebouncedValue → normalizeActivityQuery() — ending in
// `useKeysetList(orpc.alerts.deliveries, query)` instead of a single read.
//
// It is its own module on purpose. Policies and channels are configuration the product caps at
// create, so they are single reads recorded as `bounded` (apps/console/list-standard/); the list
// standard's guard decides whether a filter surface pages by whether its NEIGHBOURHOOD calls
// `useKeysetList`. Kept beside the other two views, this one call would have read as the paging of
// all three — and the two `bounded` decisions as findings that no longer existed.

import { useMemo } from "react";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import {
	labelled,
	NO_OPTIONS,
	SEARCH_DEBOUNCE,
} from "@/components/alerts/alerts-filters";
import {
	ACTIVITY_URL_PARAMS,
	DEFAULT_ACTIVITY_FILTERS,
	DELIVERY_STATUS_LABEL,
	type FacetCount,
	normalizeActivityQuery,
} from "@/components/alerts/alerts-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { AlertDeliveriesFacets } from "@/lib/queries/alerts-lists";
import { type KeysetList, useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { useAlertActivityFilters } from "@/lib/stores/use-alerts-filters";

/**
 * What the Activity panel renders from. Not a `FilteredView` (./alerts-filters.ts): the ledger is a keyset LIST, so
 * its rows, its read state and its footer all come from one {@link KeysetList}, which
 * `<DataTable keyset={…}>` renders in server mode.
 */
export interface ActivityView {
	/** Every loaded page of the ledger, the first page's read state, and the footer's state. */
	list: KeysetList<DeliveryDTO, AlertDeliveriesFacets>;
	/** The status facet over the WHOLE ledger, labelled for the chip row. */
	facets: { status: FacetCount[] };
	/** The rows on screen are the PREVIOUS filters' answer (`keepPreviousData`) — dim them. */
	stale: boolean;
	/** As `FilteredView.busy` (./alerts-filters.ts): the rows may not answer the URL and the bar yet. */
	busy: boolean;
}

/**
 * Activity: URL-synced, debounced filters resolved by `alerts.deliveries(query)`, one keyset page
 * at a time. The cursor never enters the query (it is the page param), so this `query` is the whole
 * key and a filter change starts the walk again at page one.
 */
export function useActivityView(): ActivityView {
	const filters = useAlertActivityFilters((s) => s.filters);
	const urlRead = useFilterUrlSync(
		useAlertActivityFilters,
		DEFAULT_ACTIVITY_FILTERS,
		ACTIVITY_URL_PARAMS,
	);
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE, { urlRead });
	const query = useMemo(
		() => normalizeActivityQuery({ ...filters, search }),
		[filters, search],
	);
	const list = useKeysetList(orpc.alerts.deliveries, query);
	const facets = useMemo(
		() => ({
			status: labelled(list.facets?.status ?? NO_OPTIONS, DELIVERY_STATUS_LABEL),
		}),
		[list.facets],
	);
	return {
		list,
		facets,
		stale: list.isPlaceholderData,
		busy:
			!urlRead ||
			list.isPending ||
			list.isPlaceholderData ||
			filters.search !== search,
	};
}
