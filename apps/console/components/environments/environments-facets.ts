// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's facets, as `ListToolbar` config (polish-wave spec §3, #7738): Stage and
// Status. They render the selections; the SERVER decides what they select
// (lib/queries/environments.ts), and every count here was tallied over every environment of the
// project.

import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { Activity, Layers } from "lucide-react";
import { envLifecycleBadge, stageLabel } from "@/components/environments/environment-status";
import type { EnvironmentPageFilters } from "@/components/environments/environments-query";
import type { EnvironmentFacetSet } from "@/lib/queries/environments";
import type { useEnvironmentsFilters } from "@/lib/stores/use-environments-filters";

/** The store's setter: each facet writes its own key through it. */
type SetEnvironmentFilter = ReturnType<typeof useEnvironmentsFilters.getState>["set"];

/** A lifecycle status's label, as its badge words it. */
function statusLabel(status: string): string {
	return envLifecycleBadge(status).label;
}

/**
 * The two facets of the Environments toolbar. `facets` is undefined until the first answer; the
 * facets then show with no options, and a value the link carried still reads by its label.
 */
export function environmentToolbarFacets(
	filters: EnvironmentPageFilters,
	set: SetEnvironmentFilter,
	facets: EnvironmentFacetSet | undefined,
): ListToolbarFacet[] {
	return [
		{
			label: "Stage",
			icon: Layers,
			options: (facets?.stages ?? []).map((option) => ({
				value: option.value,
				label: stageLabel(option.value),
				count: option.count,
			})),
			value: filters.stages,
			onChange: (next) => set("stages", next),
			formatValue: stageLabel,
		},
		{
			label: "Status",
			icon: Activity,
			options: (facets?.statuses ?? []).map((option) => ({
				value: option.value,
				label: statusLabel(option.value),
				count: option.count,
			})),
			value: filters.statuses,
			onChange: (next) => set("statuses", next),
			formatValue: statusLabel,
		},
	];
}
