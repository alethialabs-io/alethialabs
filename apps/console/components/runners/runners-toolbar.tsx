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
import {
	DEFAULT_RUNNER_FILTERS,
	useRunnerFilters,
} from "@/lib/stores/use-runner-filters";

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

/** Pure predicate: does a runner pass the active filters? Exported so the page reuses the
 *  exact operator/cloud/region/version semantics the chips imply. */
export function matchesRunnerFilters(
	runner: {
		status: string | null;
		operator: string;
		provisioning: string | null;
		supported_providers: string[] | null;
		location: string | null;
		version: string | null;
		runner_releases: { version: string } | null;
	},
	filters: RunnerFilters,
): boolean {
	if (filters.statuses.length && !filters.statuses.includes(runner.status ?? "OFFLINE")) {
		return false;
	}
	if (filters.operators.length) {
		const key =
			runner.operator === "managed" ? "managed" : (runner.provisioning ?? "registered");
		if (!filters.operators.includes(key)) return false;
	}
	if (filters.clouds.length) {
		const providers = runner.supported_providers;
		const matched =
			!providers || providers.length === 0
				? filters.clouds.includes("any")
				: providers.some((p) => filters.clouds.includes(p));
		if (!matched) return false;
	}
	if (filters.regions.length && !(runner.location && filters.regions.includes(runner.location))) {
		return false;
	}
	if (filters.versions.length) {
		const v = runner.runner_releases?.version ?? runner.version;
		if (!v || !filters.versions.includes(v)) return false;
	}
	return true;
}
