// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The Alerts hub's three lists, step 5 of the console filter standard (./README.md →
// "Server-side filters"): the normalized query IS the key, the fetch is the SERVER's filtered
// read, and previous rows are kept — and visibly dimmed by the caller — while the next answer
// loads.
//
// This closes the deviation `components/alerts/alerts-filters.ts` recorded against itself
// (#4890). `getAlertsBootstrap()` handed the hub the whole channel/policy/delivery universe in
// one payload and the three panels narrowed it IN MEMORY, so every filtered view of a panel
// shared one cache entry. `getAlertChannelsPage(q)` / `getAlertPoliciesPage(q)` /
// `getAlertDeliveriesPage(q)` (→ `queryAlert*Page`, all three driven by
// tests/lib/queries/filter-standard-facets.test.ts) have narrowed in SQL and returned facet
// counts over the UNFILTERED universe since #2899, and nothing called them.
//
// THE BOOTSTRAP STAYS, and it is not a duplicate read. It carries what the hub needs that is
// not a list row — the entitlement, `canManage`, the event catalog, the condition options,
// `encryptionConfigured` — plus the universes the panels select and cross-reference against
// (which channel is open in the master-detail, which policies route to the channel being
// deleted). Only the three FILTERED lists moved.
//
// #2878 refused this conversion once, and the thing it refused is still refused: a `queryFn`
// closing over the RSC `bootstrap` prop would let TanStack pin the first payload, so a mutation
// reporting success through `router.refresh()` would change nothing on screen. These hooks close
// over no prop — they call the server action with the query — and `alerts-page.tsx` now
// invalidates `["alerts"]` alongside the refresh, so both halves of the hub see a write.

import {
	keepPreviousData,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
	getAlertChannelsPage,
	getAlertDeliveriesPage,
	getAlertPoliciesPage,
} from "@/app/server/actions/alerts";
import type {
	AlertChannelsPage,
	AlertChannelsQuery,
	AlertDeliveriesPage,
	AlertDeliveriesQuery,
	AlertPoliciesPage,
	AlertPoliciesQuery,
} from "@/lib/queries/alerts-lists";
import { qk } from "./keys";

/**
 * The org's alert channels for `query`, filtered SERVER-SIDE, with the transport and
 * verification-state facets counted over every channel in the org.
 *
 * The query object is ALWAYS handed to the key, `{}` included: `qk.alertChannels(org)` is the
 * unfiltered universe key, and it would carry a different payload shape. `["alerts"]` still
 * invalidates every list on the hub.
 *
 * @param query the `normalizeChannelsQuery()` output; `{}` is the pristine view
 * @param enabled false on the upsell path — the plan does not unlock alerting, no list renders,
 *   and three authorized reads for rows nobody will see is three round-trips for nothing
 */
export function useAlertChannelsPageQuery(
	query: AlertChannelsQuery = {},
	enabled = true,
): UseQueryResult<AlertChannelsPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.alertChannels(org, query),
		queryFn: () => getAlertChannelsPage(query),
		placeholderData: keepPreviousData,
		enabled,
	});
}

/**
 * The org's alert policies for `query`, filtered SERVER-SIDE, with the status, kind and
 * destination-channel facets counted over every policy in the org.
 *
 * @param query the `normalizePoliciesQuery()` output; `{}` is the pristine view
 * @param enabled see {@link useAlertChannelsPageQuery}
 */
export function useAlertPoliciesPageQuery(
	query: AlertPoliciesQuery = {},
	enabled = true,
): UseQueryResult<AlertPoliciesPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.alertPolicies(org, query),
		queryFn: () => getAlertPoliciesPage(query),
		placeholderData: keepPreviousData,
		enabled,
	});
}

/**
 * The org's delivery ledger for `query`, filtered SERVER-SIDE and THEN windowed, with the
 * status facet counted over the WHOLE ledger rather than over the window.
 *
 * This is the one of the three that the bootstrap could not answer at all: its `deliveries` are
 * the newest 50 rows, so a status that last occurred 200 rows ago was invisible to the in-memory
 * filter AND absent from its facet counts. Filtering in SQL is what makes it reachable.
 *
 * @param query the `normalizeActivityQuery()` output; `{}` is the pristine view
 * @param enabled see {@link useAlertChannelsPageQuery}
 */
export function useAlertDeliveriesPageQuery(
	query: AlertDeliveriesQuery = {},
	enabled = true,
): UseQueryResult<AlertDeliveriesPage> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.alertDeliveries(org, query),
		queryFn: () => getAlertDeliveriesPage(query),
		placeholderData: keepPreviousData,
		enabled,
	});
}
