// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's facets, as `ListToolbar` config (polish-wave spec §3, #7738): Status (the
// health buckets), Group (the seven presentation groups) and Vendor (the long vendor list, which
// `FacetFilter` gives a search box past eight options). Counts come from the UNFILTERED universe, so
// an option never vanishes as you select it. State lives in the page's URL-synced zustand store.

import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { Activity, Building2, Layers } from "lucide-react";
import type { ConnectorFacetOption, ConnectorFacets, ConnectorFilters } from "@/components/connectors/connectors-query";
import type { useConnectorFilters } from "@/lib/stores/use-connector-filters";

/** The store's setter: each facet writes its own key through it. */
type SetConnectorFilter = ReturnType<typeof useConnectorFilters.getState>["set"];

/** One server facet option as a `FacetFilter` option, its count in the trailing mono figure. */
function facetOption(option: ConnectorFacetOption): { value: string; label: string; count: number } {
	return { value: option.value, label: option.label, count: option.count };
}

/** The three facets of the connectors toolbar, in the row's order. */
export function connectorToolbarFacets(
	filters: ConnectorFilters,
	set: SetConnectorFilter,
	facets: ConnectorFacets,
): ListToolbarFacet[] {
	return [
		{
			label: "Status",
			icon: Activity,
			options: facets.health.map(facetOption),
			value: filters.health,
			onChange: (next) => set("health", next),
		},
		{
			label: "Group",
			icon: Layers,
			options: facets.groups.map(facetOption),
			value: filters.groups,
			onChange: (next) => set("groups", next),
			searchPlaceholder: "Search groups…",
			emptyText: "No groups.",
		},
		{
			label: "Vendor",
			icon: Building2,
			options: facets.vendors.map(facetOption),
			value: filters.vendors,
			onChange: (next) => set("vendors", next),
			searchPlaceholder: "Search vendors…",
			emptyText: "No vendors.",
		},
	];
}
