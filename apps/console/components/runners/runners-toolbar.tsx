"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners filter bar — the console filter standard (#578): FilterSearch + the shared
// CloudFilter + always-visible chip groups (status / operator) + facet popovers
// (region / version) + the mono Reset. Reads/writes the page's zustand filter store
// (use-runner-filters); the page owns URL sync + debounce. The local Chip/ChipGroup
// this file used to define were promoted to @repo/ui/filter-chip (prop-compatible)
// and are consumed from there now.

import { Globe, Tag } from "lucide-react";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import { CloudFilter, type CloudFilterOption } from "@/components/filters/cloud-filter";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { DEFAULT_RUNNER_FILTERS } from "@/components/runners/runners-query";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";

/** Active filter selections for the runners grid (sans search). Empty = "no filter". */
export interface RunnerFilters {
	clouds: string[];
	statuses: string[];
	operators: string[];
	regions: string[];
	versions: string[];
}

const STATUS_OPTIONS = [
	{ value: "ONLINE", label: "Online" },
	{ value: "OFFLINE", label: "Offline" },
	{ value: "DRAINING", label: "Draining" },
];

const OPERATOR_OPTIONS = [
	{ value: "managed", label: "Managed" },
	{ value: "deployed", label: "Self · Deployed" },
	{ value: "registered", label: "Self · Registered" },
];

/** A facet option whose count comes from the UNFILTERED runner set (the standard: options
 * never disappear as you select them). */
export interface RunnerFacetOption {
	value: string;
	label: string;
	count: number;
}

export function RunnersToolbar({
	cloudOptions,
	regionOptions,
	versionOptions,
}: {
	cloudOptions: CloudFilterOption[];
	regionOptions: RunnerFacetOption[];
	versionOptions: RunnerFacetOption[];
}) {
	const filters = useRunnerFilters((s) => s.filters);
	const set = useRunnerFilters((s) => s.set);
	const reset = useRunnerFilters((s) => s.reset);

	const toggle = (key: keyof RunnerFilters, value: string) => {
		const arr = filters[key];
		set(
			key,
			arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value],
		);
	};

	return (
		<FilterBar
			end={
				<FilterBarReset
					count={countActiveFilters(filters, DEFAULT_RUNNER_FILTERS)}
					onReset={reset}
				/>
			}
		>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Search runners by name…"
				ariaLabel="Search runners"
			/>
			<CloudFilter
				value={filters.clouds}
				onChange={(next) => set("clouds", next)}
				options={cloudOptions}
			/>
			<FilterChipGroup
				inline
				options={STATUS_OPTIONS}
				selected={filters.statuses}
				onToggle={(v) => toggle("statuses", v)}
			/>
			<FilterChipGroup
				inline
				options={OPERATOR_OPTIONS}
				selected={filters.operators}
				onToggle={(v) => toggle("operators", v)}
			/>
			<FacetFilter
				label="Region"
				icon={Globe}
				options={regionOptions.map((o) => ({
					value: o.value,
					label: o.label,
					hint: String(o.count),
				}))}
				value={filters.regions}
				onChange={(next) => set("regions", next)}
			/>
			<FacetFilter
				label="Version"
				icon={Tag}
				options={versionOptions.map((o) => ({
					value: o.value,
					label: o.label,
					hint: String(o.count),
				}))}
				value={filters.versions}
				onChange={(next) => set("versions", next)}
			/>
		</FilterBar>
	);
}

// The predicate that used to live here moved to `lib/queries/runners.ts` with the filtering
// itself (#4890). A filter BAR is the wrong home for "does this row match": the bar renders
// the selections, the SERVER decides what they select.
