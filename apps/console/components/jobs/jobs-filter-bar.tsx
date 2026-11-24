"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_JOBS_FILTERS } from "@/components/jobs/jobs-query";
import { JOB_TYPES } from "@/lib/jobs/format";
import type { FacetOption } from "@/lib/queries/facets";
import type { JobsFacets } from "@/lib/queries/jobs";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useJobsFilters } from "@/lib/stores/use-jobs-filters";
import { parseRangeFilter, rangeFilterLabel, rangeFromPick, rangeWindowValue } from "@/lib/query/range-filter";
import { JOBS_DEFAULT_PRESET } from "@/lib/rpc/inputs/jobs";
import { lookup } from "@/lib/typed-object";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { type ComboboxOption, MultiCombobox } from "@repo/ui/multi-combobox";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import { type DateRange, RANGE_PRESETS } from "@repo/ui/range";
import { Activity, Boxes, Layers, Users, Wrench } from "lucide-react";

/** The quick-range label the list opens on, and returns to on a reset: the default preset's. */
const JOBS_DEFAULT_RANGE_LABEL =
	RANGE_PRESETS.find((p) => p.id === JOBS_DEFAULT_PRESET)?.label ?? "Last 12 months";

const STATUS_LABELS = new Map(
	["QUEUED", "CLAIMED", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED"].map((s) => [
		s,
		s.charAt(0) + s.slice(1).toLowerCase(),
	]),
);

/** Facet options → MultiCombobox options: label fallback + the count as the hint. */
function comboOptions(
	facet: FacetOption[] | undefined,
	label: (o: FacetOption) => string = (o) => o.label ?? o.value,
): ComboboxOption[] {
	return (facet ?? []).map((o) => ({
		value: o.value,
		label: label(o),
		hint: String(o.count),
	}));
}

/**
 * The jobs filter store's state. The bar's values and its two mutators ARE the store's — `JobsClient`
 * hands over `filters`, `set` and `reset` as they come — so their types are read from the store
 * rather than restated beside it.
 */
type JobsFilterStore = ReturnType<typeof useJobsFilters.getState>;

/** What the jobs filter bar shows and what each control reports back. */
interface JobsFilterBarProps {
	/** False on a project's own jobs list: the Project facet is dropped, as the column is. */
	showProject: boolean;
	filters: JobsFilterStore["filters"];
	/** Set one filter (the store's `set`). */
	onFilter: JobsFilterStore["set"];
	/** Reset every store filter (the store's `reset`). */
	onReset: JobsFilterStore["reset"];
	/**
	 * The window the two range controls show: `filters.range` resolved to dates by the caller, once,
	 * so a preset's window does not move on every render (`jobsRangeWindow`). What a pick WRITES is
	 * the `range` filter value — a preset's id, or an explicit window — through `onFilter`.
	 */
	range: DateRange;
	/** Author options, already resolved against the org's members. */
	authorOptions: ComboboxOption[];
	authorsLoading: boolean;
	facets: JobsFacets | undefined;
	onCreateProject: () => void;
	className?: string;
}

/**
 * The jobs list's filter bar — search, quick range, date range, then a combobox per facet: authors,
 * environments, projects (org list only), statuses, types. The range is one of the store's filters
 * like the rest, so the bar's "Reset · N" counts it and clears it.
 *
 * ONE COMPONENT, TWO RENDERERS: `JobsClient` renders it live, and `JobsListSkeleton` renders it
 * inert with the defaults while the route prefetches (#6350). The bar WRAPS, and where it wraps is
 * decided by the controls' own widths — the search's minimum, the range labels, the comboboxes'
 * fixed `w-40` — so a skeleton that drew bars of guessed widths wrapped somewhere else: on a
 * project's list it fit one line where the page needs two, and the table landed 46px lower than
 * the skeleton had drawn it (B2 0.020 on release-gate run 40822681524). Drawing the skeleton's bar
 * from this component is what makes the two wrap at the same width, at every width.
 */
export function JobsFilterBar({
	showProject,
	filters,
	onFilter,
	onReset,
	range,
	authorOptions,
	authorsLoading,
	facets,
	onCreateProject,
	className,
}: JobsFilterBarProps) {
	return (
		<FilterBar
			className={className}
			end={
				<FilterBarReset
					count={countActiveFilters(filters, DEFAULT_JOBS_FILTERS)}
					onReset={onReset}
				/>
			}
		>
			<FilterSearch
				value={filters.search}
				onChange={(v) => onFilter("search", v)}
				placeholder="Filter by project, environment, or error…"
				ariaLabel="Search jobs"
				className="w-[220px] max-w-[340px] flex-1"
			/>
			{/* One choice, one label: a preset's name, or "Custom range" over explicit bounds — never a
			    relative name over fixed dates. A preset is stored as its id, so its link stays relative. */}
			<QuickRangeFilter
				label={rangeFilterLabel(parseRangeFilter(filters.range), JOBS_DEFAULT_RANGE_LABEL)}
				value={range}
				onChange={(picked, label) => onFilter("range", rangeFromPick(picked, label))}
			/>
			<DateRangeFilter value={range} onChange={(picked) => onFilter("range", rangeWindowValue(picked))} />
			<MultiCombobox
				placeholder="All authors"
				icon={Users}
				options={authorOptions}
				value={filters.authors}
				onChange={(next) => onFilter("authors", next)}
				withAvatar
				loading={authorsLoading}
			/>
			<MultiCombobox
				placeholder="All environments"
				icon={Layers}
				options={comboOptions(facets?.envs)}
				value={filters.envs}
				onChange={(next) => onFilter("envs", next)}
			/>
			{showProject && (
				<MultiCombobox
					placeholder="All projects"
					icon={Boxes}
					options={comboOptions(facets?.projects)}
					value={filters.projects}
					onChange={(next) => onFilter("projects", next)}
					emptyAction={{ label: "Create project", onSelect: onCreateProject }}
				/>
			)}
			<MultiCombobox
				placeholder="All statuses"
				icon={Activity}
				options={comboOptions(facets?.statuses, (o) => STATUS_LABELS.get(o.value) ?? o.value)}
				value={filters.statuses}
				onChange={(next) => onFilter("statuses", next)}
			/>
			<MultiCombobox
				placeholder="All types"
				icon={Wrench}
				options={comboOptions(facets?.types, (o) => lookup(JOB_TYPES, o.value)?.label ?? o.value)}
				value={filters.types}
				onChange={(next) => onFilter("types", next)}
			/>
		</FilterBar>
	);
}
