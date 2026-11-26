"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The evidence page's funnel — the shared funnel popover (Cloud / Stage / Status facets,
// check-on-the-right) that rides in the page's one `ListToolbar` as its `extra` (polish-wave spec §3,
// #7738: per-page variation goes through `extra` only). Filter state lives in the page's URL-synced
// zustand store; grouping is fixed to project, so the funnel carries facets + Reset only (no
// Group/Sort control).
//
// The toolbar ALSO renders the row-level "Reset · N", like every other list page
// (lib/query/README.md). The funnel's own Reset only shows once its popover is open, so without
// the row-level one this page lacked the reset affordance the rest of the console shares (#5064).
// Both call the same store `reset`, and both read the same active-filter count.

import { Cloud, Layers, ShieldAlert } from "lucide-react";
import { FunnelFilter, type FunnelFacet } from "@repo/ui/funnel-filter";
import { ProviderIcon } from "@repo/ui/provider-icon";
import type { EvidenceFacetOption } from "@/lib/rpc/procedures/evidence";
import {
	CLOUD_FILTER_VALUES,
	DEFAULT_EVIDENCE_FILTERS,
	type EvidenceFilters,
} from "@/components/evidence/evidence-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";

const KNOWN_CLOUDS = new Set<string>(CLOUD_FILTER_VALUES);

/** Toggle one value in a selection array. */
function toggled(selection: string[], value: string): string[] {
	return selection.includes(value)
		? selection.filter((v) => v !== value)
		: [...selection, value];
}

/** The Cloud / Stage / Status funnel; filter state lives in the page's zustand store (URL-synced). */
export function EvidenceFunnel({
	statusOptions,
	stageOptions,
	providerOptions,
}: {
	statusOptions: EvidenceFacetOption[];
	stageOptions: EvidenceFacetOption[];
	providerOptions: EvidenceFacetOption[];
}) {
	const filters = useEvidenceFilters((s) => s.filters);
	const set = useEvidenceFilters((s) => s.set);
	const reset = useEvidenceFilters((s) => s.reset);
	const activeFilters = countActiveFilters<EvidenceFilters>(
		filters,
		DEFAULT_EVIDENCE_FILTERS,
	);

	const facets: FunnelFacet[] = [
		{
			key: "providers",
			label: "Cloud",
			icon: Cloud,
			options: providerOptions.map((o) => ({
				value: o.value,
				label: o.label,
				count: o.count,
				leading: KNOWN_CLOUDS.has(o.value) ? (
					<ProviderIcon provider={o.value} size={14} className="grayscale" />
				) : (
					<Layers className="size-3.5 shrink-0 text-muted-foreground" />
				),
			})),
		},
		{
			key: "stages",
			label: "Stage",
			icon: Layers,
			options: stageOptions.map((o) => ({
				value: o.value,
				label: o.label,
				count: o.count,
			})),
		},
		{
			key: "status",
			label: "Status",
			icon: ShieldAlert,
			options: statusOptions.map((o) => ({
				value: o.value,
				label: o.label,
				count: o.count,
			})),
		},
	];

	const onToggle = (key: string, value: string) => {
		if (key === "providers") set("providers", toggled(filters.providers, value));
		else if (key === "stages") set("stages", toggled(filters.stages, value));
		else if (key === "status") set("status", toggled(filters.status, value));
	};

	return (
		<FunnelFilter
			facets={facets}
			selected={{
				providers: filters.providers,
				stages: filters.stages,
				status: filters.status,
			}}
			onToggle={onToggle}
			onReset={reset}
			dirty={activeFilters > 0}
		/>
	);
}
