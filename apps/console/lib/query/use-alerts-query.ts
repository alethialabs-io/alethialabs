// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The Alerts hub's reads (#6125, ADR 0005 D1): the `alerts.*` GET procedures, under the same keys
// the route prefetches through `serverOrpc()`, so the first paint carries the data and the browser
// asks for nothing on mount.
//
// The three lists are step 5 of the console filter standard (./README.md → "Server-side filters"):
// the normalized query IS the input, the read is the SERVER's filtered page, and previous rows are
// kept — and visibly dimmed by the caller — while the next answer loads. Their PRISTINE pages
// (`{}`) double as the universes the panels cross-reference against (which channel is open in the
// master-detail, which policies route to the channel being deleted), so there is no second read of
// the same rows.
//
// NO POLL, and no `router.refresh()`. A write invalidates {@link alertsKeys} from the acting tab;
// every other tab and member hears an `alerts` hint on the org's change stream (the alert tables'
// triggers in lib/db/programmables.sql, routed to members who may `view_alerts` —
// lib/realtime/routing.ts), which invalidates the same keys (lib/query/topics.ts). While the stream
// is down the one sanctioned fallback poll covers them (lib/realtime/client/fallback-poll.ts).

import {
	keepPreviousData,
	type QueryKey,
	useQuery,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	AlertChannelsPage,
	AlertChannelsQuery,
	AlertDeliveriesPage,
	AlertDeliveriesQuery,
	AlertPoliciesPage,
	AlertPoliciesQuery,
} from "@/lib/queries/alerts-lists";
import type { AlertsSettings } from "@/lib/rpc/procedures/alerts";
import { orpc } from "@/lib/rpc/client";

/** The hub's settings: the plan gate, `canManage`, the event catalog and the condition options. */
export function useAlertsSettingsQuery(): UseQueryResult<AlertsSettings> {
	return useQuery(orpc.alerts.settings.queryOptions());
}

/**
 * The org's alert channels for `query`, filtered SERVER-SIDE, with the transport and
 * verification-state facets counted over every channel in the org.
 *
 * @param query the `normalizeChannelsQuery()` output; `{}` is the pristine view (and the universe)
 */
export function useAlertChannelsPageQuery(
	query: AlertChannelsQuery = {},
): UseQueryResult<AlertChannelsPage> {
	return useQuery({
		...orpc.alerts.channels.queryOptions({ input: query }),
		placeholderData: keepPreviousData,
	});
}

/**
 * The org's alert policies for `query`, filtered SERVER-SIDE, with the status, kind and
 * destination-channel facets counted over every policy in the org.
 *
 * @param query the `normalizePoliciesQuery()` output; `{}` is the pristine view (and the universe)
 */
export function useAlertPoliciesPageQuery(
	query: AlertPoliciesQuery = {},
): UseQueryResult<AlertPoliciesPage> {
	return useQuery({
		...orpc.alerts.policies.queryOptions({ input: query }),
		placeholderData: keepPreviousData,
	});
}

/**
 * The org's delivery ledger for `query`, filtered SERVER-SIDE and THEN windowed, with the
 * status facet counted over the WHOLE ledger rather than over the window.
 *
 * @param query the `normalizeActivityQuery()` output; `{}` is the pristine view
 */
export function useAlertDeliveriesPageQuery(
	query: AlertDeliveriesQuery = {},
): UseQueryResult<AlertDeliveriesPage> {
	return useQuery({
		...orpc.alerts.deliveries.queryOptions({ input: query }),
		placeholderData: keepPreviousData,
	});
}

/**
 * Every key that shows alert data: the hub's reads and the overview's Alerts card. A write on the
 * hub invalidates all of them, so no screen keeps the old row (the `alerts` topic maps to the same).
 */
export function alertsKeys(): QueryKey[] {
	return [orpc.alerts.key(), orpc.overview.alerts.key()];
}
