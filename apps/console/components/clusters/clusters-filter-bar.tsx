"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters filter bar — the console filter standard: FilterSearch, the shared CloudFilter, the
// four statuses as always-visible chips, a Region facet and the mono Reset. It renders the
// selections and nothing else: the SERVER decides what they select (lib/queries/clusters.ts), and
// every count here was tallied over the scope's unfiltered clusters.

import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import { cn } from "@repo/ui/utils";
import { Globe } from "lucide-react";
import { providerName } from "@/components/clusters/cloud-label";
import { CLUSTER_STATUS_KEYS, type ClusterStatusKey } from "@/components/clusters/cluster-posture";
import { type ClusterPageFilters, DEFAULT_CLUSTER_FILTERS } from "@/components/clusters/clusters-query";
import { CloudFilter } from "@/components/filters/cloud-filter";
import { CLOUD_ACCOUNT } from "@/lib/copy/vocabulary";
import { type ClusterFacetSet, UNKNOWN_CLOUD } from "@/lib/queries/clusters";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useClustersFilters } from "@/lib/stores/use-clusters-filters";

/** The store the bar renders: its `set` and `reset` are the bar's two handlers. */
type ClustersFilterStore = ReturnType<typeof useClustersFilters.getState>;

/**
 * What each filter status is called. A function over `ClusterStatusKey`, not a table keyed on
 * status words: what a status LOOKS like is `@repo/ui/status-badge`'s to say, and this only names
 * four groups of them for the bar.
 */
export function clusterStatusLabel(key: ClusterStatusKey): string {
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

/** Narrows a facet value to one of the four statuses the bar labels. */
function isStatusKey(value: string): value is ClusterStatusKey {
	return CLUSTER_STATUS_KEYS.some((key) => key === value);
}

/** The label of a cloud-facet value: the provider's short name, or the bucket for an unknown one. */
function cloudOptionLabel(value: string): string {
	return value === UNKNOWN_CLOUD ? `No ${CLOUD_ACCOUNT.one}` : providerName(value);
}

/**
 * The bar. `facets` is undefined until the first answer; the bar then shows its controls with no
 * options, which is also the form the route's skeleton draws.
 */
export function ClustersFilterBar({
	filters,
	onFilter,
	onReset,
	facets,
	className,
}: {
	filters: ClusterPageFilters;
	onFilter: ClustersFilterStore["set"];
	onReset: ClustersFilterStore["reset"];
	facets: ClusterFacetSet | undefined;
	className?: string;
}) {
	const statusOptions = (facets?.statuses ?? [])
		.map((option) => option.value)
		.filter(isStatusKey)
		.map((value) => ({
			value,
			label: clusterStatusLabel(value),
			count: facets?.statuses.find((option) => option.value === value)?.count,
		}));

	return (
		<FilterBar
			className={cn(className)}
			end={<FilterBarReset count={countActiveFilters(filters, DEFAULT_CLUSTER_FILTERS)} onReset={onReset} />}
		>
			<FilterSearch
				value={filters.search}
				onChange={(value) => onFilter("search", value)}
				placeholder="Search by environment, project or cluster…"
				ariaLabel="Search clusters"
			/>
			<CloudFilter
				value={filters.clouds}
				onChange={(next) => onFilter("clouds", next)}
				options={(facets?.clouds ?? []).map((option) => ({
					value: option.value,
					label: cloudOptionLabel(option.value),
					count: option.count,
				}))}
			/>
			<FilterChipGroup
				inline
				options={statusOptions}
				selected={filters.statuses}
				onToggle={(value) =>
					onFilter(
						"statuses",
						filters.statuses.includes(value)
							? filters.statuses.filter((status) => status !== value)
							: [...filters.statuses, value],
					)
				}
			/>
			<FacetFilter
				label="Region"
				icon={Globe}
				options={(facets?.regions ?? []).map((option) => ({
					value: option.value,
					label: option.value,
					hint: String(option.count),
				}))}
				value={filters.regions}
				onChange={(next) => onFilter("regions", next)}
			/>
		</FilterBar>
	);
}
