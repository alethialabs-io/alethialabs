"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The evidence filter bar — the reference implementation of the console filter
// standard's visual grammar (lib/query/README.md): search → cloud multi-select →
// always-visible stage chips → Status facet → mono Reset. One language: no Selects,
// no "N of M" prose (the count lives in the pill next to the Environments heading).

import { ShieldAlert } from "lucide-react";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import type { EvidenceFacetOption } from "@/app/server/actions/evidence";
import { CloudFilter } from "@/components/filters/cloud-filter";
import {
	DEFAULT_EVIDENCE_FILTERS,
	type EvidenceFilters,
} from "@/components/evidence/evidence-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";

/** Toggle one value in a selection array. */
function toggled(selection: string[], value: string): string[] {
	return selection.includes(value)
		? selection.filter((v) => v !== value)
		: [...selection, value];
}

/** The filter bar; filter state lives in the page's zustand store (URL-synced). */
export function EvidenceFilterBar({
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

	return (
		<FilterBar>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter by project or environment…"
				className="w-[240px] max-w-[380px] flex-1"
			/>
			<CloudFilter
				value={filters.providers}
				onChange={(v) => set("providers", v)}
				options={providerOptions}
			/>
			<FilterChipGroup
				inline
				options={stageOptions}
				selected={filters.stages}
				onToggle={(v) => set("stages", toggled(filters.stages, v))}
				render={(opt) => (
					<>
						{opt.label}
						<span className="font-mono text-[10px] opacity-55 tabular-nums">
							{opt.count}
						</span>
					</>
				)}
			/>
			<FacetFilter
				label="Status"
				icon={ShieldAlert}
				options={statusOptions.map((o) => ({
					value: o.value,
					label: o.label,
					hint: String(o.count),
				}))}
				value={filters.status}
				onChange={(v) => set("status", v)}
				searchPlaceholder="Search statuses…"
				emptyText="No statuses."
			/>
			<FilterBarReset
				count={countActiveFilters<EvidenceFilters>(
					filters,
					DEFAULT_EVIDENCE_FILTERS,
				)}
				onReset={reset}
			/>
		</FilterBar>
	);
}
