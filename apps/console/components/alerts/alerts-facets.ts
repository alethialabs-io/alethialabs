// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's three toolbars' facets, as `ListToolbar` config (polish-wave spec §3, #7738).
// Each panel renders ONE `ListToolbar` from these: the facet options and their counts arrive from
// the panel's view (tallied over the UNFILTERED universe, so an option never vanishes as it is
// selected), and the selections are read and written straight through the panel's store. No
// result count anywhere — totals exist only as facet option counts (#7489).

import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { Activity, Send, Tag, Webhook } from "lucide-react";
import type { ActivityView } from "@/components/alerts/activity-view";
import type { ChannelsView, PoliciesView } from "@/components/alerts/alerts-filters";
import type { ActivityFilters, ChannelFilters, FacetCount, PolicyFilters } from "@/components/alerts/alerts-query";
import type {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";

/** A facet's options, each count as the option's trailing figure. */
function facetOptions(options: FacetCount[]) {
	return options.map((o) => ({ value: o.value, label: o.label, count: o.count }));
}

/** Channels: the transport facet and the verification state. */
export function channelToolbarFacets(
	filters: ChannelFilters,
	set: ReturnType<typeof useAlertChannelFilters.getState>["set"],
	facets: ChannelsView["facets"],
): ListToolbarFacet[] {
	return [
		{
			label: "Transport",
			icon: Webhook,
			options: facetOptions(facets.types),
			value: filters.types,
			onChange: (next) => set("types", next),
			searchPlaceholder: "Search transports…",
			emptyText: "No transports configured.",
		},
		{
			label: "Status",
			icon: Activity,
			options: facetOptions(facets.status),
			value: filters.status,
			onChange: (next) => set("status", next),
		},
	];
}

/** Policies: status, kind and the destination channel. */
export function policyToolbarFacets(
	filters: PolicyFilters,
	set: ReturnType<typeof useAlertPolicyFilters.getState>["set"],
	facets: PoliciesView["facets"],
): ListToolbarFacet[] {
	return [
		{
			label: "Status",
			icon: Activity,
			options: facetOptions(facets.status),
			value: filters.status,
			onChange: (next) => set("status", next),
		},
		{
			label: "Kind",
			icon: Tag,
			options: facetOptions(facets.kinds),
			value: filters.kinds,
			onChange: (next) => set("kinds", next),
		},
		{
			label: "Channel",
			icon: Send,
			options: facetOptions(facets.channels),
			value: filters.channels,
			onChange: (next) => set("channels", next),
			searchPlaceholder: "Search channels…",
			emptyText: "No channels configured.",
		},
	];
}

/** Activity: the delivery status. */
export function activityToolbarFacets(
	filters: ActivityFilters,
	set: ReturnType<typeof useAlertActivityFilters.getState>["set"],
	facets: ActivityView["facets"],
): ListToolbarFacet[] {
	return [
		{
			label: "Status",
			icon: Activity,
			options: facetOptions(facets.status),
			value: filters.status,
			onChange: (next) => set("status", next),
		},
	];
}
