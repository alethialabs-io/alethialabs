"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments filter bar — the console filter standard: FilterSearch, the three stages as
// always-visible chips, a Status facet and the mono Reset. It renders the selections; the SERVER
// decides what they select (lib/queries/environments.ts), and every count here was tallied over
// every environment of the project.

import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import { Activity } from "lucide-react";
import { envLifecycleBadge, stageLabel } from "@/components/environments/environment-status";
import {
	DEFAULT_ENVIRONMENT_FILTERS,
	type EnvironmentPageFilters,
} from "@/components/environments/environments-query";
import type { EnvironmentFacetSet } from "@/lib/queries/environments";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useEnvironmentsFilters } from "@/lib/stores/use-environments-filters";

/** The store the bar renders: its `set` and `reset` are the bar's two handlers. */
type EnvironmentsFilterStore = ReturnType<typeof useEnvironmentsFilters.getState>;

/**
 * The bar. `facets` is undefined until the first answer; the bar then shows its controls with no
 * options, which is also the form the route's skeleton draws.
 */
export function EnvironmentsFilterBar({
	filters,
	onFilter,
	onReset,
	facets,
	className,
}: {
	filters: EnvironmentPageFilters;
	onFilter: EnvironmentsFilterStore["set"];
	onReset: EnvironmentsFilterStore["reset"];
	facets: EnvironmentFacetSet | undefined;
	className?: string;
}) {
	return (
		<FilterBar
			className={className}
			end={<FilterBarReset count={countActiveFilters(filters, DEFAULT_ENVIRONMENT_FILTERS)} onReset={onReset} />}
		>
			<FilterSearch
				value={filters.search}
				onChange={(value) => onFilter("search", value)}
				placeholder="Search environments by name…"
				ariaLabel="Search environments"
			/>
			<FilterChipGroup
				inline
				options={(facets?.stages ?? []).map((option) => ({
					value: option.value,
					label: stageLabel(option.value),
					count: option.count,
				}))}
				selected={filters.stages}
				onToggle={(value) =>
					onFilter(
						"stages",
						filters.stages.includes(value)
							? filters.stages.filter((stage) => stage !== value)
							: [...filters.stages, value],
					)
				}
			/>
			<FacetFilter
				label="Status"
				icon={Activity}
				options={(facets?.statuses ?? []).map((option) => ({
					value: option.value,
					label: envLifecycleBadge(option.value).label,
					hint: String(option.count),
				}))}
				value={filters.statuses}
				onChange={(next) => onFilter("statuses", next)}
			/>
		</FilterBar>
	);
}
