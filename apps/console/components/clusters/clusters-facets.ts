// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters list's facets, as `ListToolbar` config (polish-wave spec §3, #7738): Cloud, Status
// and Region. It renders the selections and nothing else: the SERVER decides what they select
// (lib/queries/clusters.ts), and every count here was tallied over the scope's unfiltered clusters.

import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { Activity, Cloud, Globe } from "lucide-react";
import { providerName } from "@/components/clusters/cloud-label";
import { CLUSTER_STATUS_KEYS, type ClusterStatusKey } from "@/components/clusters/cluster-posture";
import type { ClusterPageFilters } from "@/components/clusters/clusters-query";
import { CLOUD_ACCOUNT } from "@/lib/copy/vocabulary";
import { type ClusterFacetSet, UNKNOWN_CLOUD } from "@/lib/queries/clusters";
import type { useClustersFilters } from "@/lib/stores/use-clusters-filters";

/** The store's setter: each facet writes its own key through it. */
type SetClusterFilter = ReturnType<typeof useClustersFilters.getState>["set"];

/**
 * What each filter status is called. A function over `ClusterStatusKey`, not a table keyed on
 * status words: what a status LOOKS like is `@repo/ui/status-badge`'s to say, and this only names
 * four groups of them for the toolbar.
 */
function clusterStatusLabel(key: ClusterStatusKey): string {
	switch (key) {
		case "failed":
			return "Needs attention";
		case "pending":
			return "In progress";
		case "active":
			return "Healthy";
		case "idle":
			return "Unverified";
	}
}

/** Narrows a facet value to one of the four statuses the toolbar labels. */
function isStatusKey(value: string): value is ClusterStatusKey {
	return CLUSTER_STATUS_KEYS.some((key) => key === value);
}

/** The label of a status value, or the raw value for one the toolbar does not name. */
function statusOptionLabel(value: string): string {
	return isStatusKey(value) ? clusterStatusLabel(value) : value;
}

/** The label of a cloud-facet value: the provider's short name, or the bucket for an unknown one. */
function cloudOptionLabel(value: string): string {
	return value === UNKNOWN_CLOUD ? `No ${CLOUD_ACCOUNT.one}` : providerName(value);
}

/**
 * The three facets of the clusters toolbar. `facets` is undefined until the first answer; the
 * facets then show with no options, and a value the link carried still reads by its label.
 */
export function clusterToolbarFacets(
	filters: ClusterPageFilters,
	set: SetClusterFilter,
	facets: ClusterFacetSet | undefined,
): ListToolbarFacet[] {
	return [
		{
			label: "Cloud",
			icon: Cloud,
			options: (facets?.clouds ?? []).map((option) => ({
				value: option.value,
				label: cloudOptionLabel(option.value),
				count: option.count,
			})),
			value: filters.clouds,
			onChange: (next) => set("clouds", next),
			formatValue: cloudOptionLabel,
		},
		{
			label: "Status",
			icon: Activity,
			options: (facets?.statuses ?? [])
				.filter((option) => isStatusKey(option.value))
				.map((option) => ({ value: option.value, label: statusOptionLabel(option.value), count: option.count })),
			value: filters.statuses,
			onChange: (next) => set("statuses", next),
			formatValue: statusOptionLabel,
		},
		{
			label: "Region",
			icon: Globe,
			options: (facets?.regions ?? []).map((option) => ({
				value: option.value,
				label: option.value,
				count: option.count,
			})),
			value: filters.regions,
			onChange: (next) => set("regions", next),
		},
	];
}
