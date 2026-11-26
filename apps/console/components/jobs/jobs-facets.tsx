"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs list's toolbar pieces, as `ListToolbar` config (polish-wave spec §3, #7738): the five
// facets — Author, Environment, Project (org list only), Status, Type — and the range control. The
// SERVER decides what each selects (lib/queries/jobs.ts); every count here was tallied over the
// scope's unfiltered jobs. The range is one of the store's filters like the rest, so `Reset · N`
// counts it and clears it.

import { DateRangeFilter } from "@repo/ui/date-range-filter";
import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import { type DateRange, RANGE_PRESETS } from "@repo/ui/range";
import { Activity, Boxes, Layers, Users, Wrench } from "lucide-react";
import type { JobsFilters } from "@/components/jobs/jobs-query";
import { JOB_TYPES } from "@/lib/jobs/format";
import type { FacetOption } from "@/lib/queries/facets";
import type { JobsFacets } from "@/lib/queries/jobs";
import { parseRangeFilter, rangeFilterLabel, rangeFromPick, rangeWindowValue } from "@/lib/query/range-filter";
import { JOBS_DEFAULT_PRESET } from "@/lib/rpc/inputs/jobs";
import type { useJobsFilters } from "@/lib/stores/use-jobs-filters";
import { lookup } from "@/lib/typed-object";

/** The store's setter: each control writes its own key through it. */
type SetJobsFilter = ReturnType<typeof useJobsFilters.getState>["set"];

/** The quick-range label the list opens on, and returns to on a reset: the default preset's. */
const JOBS_DEFAULT_RANGE_LABEL = RANGE_PRESETS.find((p) => p.id === JOBS_DEFAULT_PRESET)?.label ?? "Last 12 months";

const STATUS_LABELS = new Map(
	["QUEUED", "CLAIMED", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED"].map((s) => [s, s.charAt(0) + s.slice(1).toLowerCase()]),
);

/** A job status's label: `Success` for `SUCCESS`, or the raw value for one this list does not name. */
function statusLabel(value: string): string {
	return STATUS_LABELS.get(value) ?? value;
}

/** A job type's label from `JOB_TYPES`, or the raw value for one this list does not name. */
function typeLabel(value: string): string {
	return lookup(JOB_TYPES, value)?.label ?? value;
}

/** A facet's server options as `FacetFilter` options: the label (or a fallback) and the count. */
function facetOptions(facet: FacetOption[] | undefined, label: (o: FacetOption) => string = (o) => o.label ?? o.value) {
	return (facet ?? []).map((o) => ({ value: o.value, label: label(o), count: o.count }));
}

/** A label for a facet value whose option has not loaded: the option's label once it has. */
function labelFrom(facet: FacetOption[] | undefined): (value: string) => string {
	return (value) => facet?.find((o) => o.value === value)?.label ?? value;
}

/**
 * The jobs toolbar's facets. `authorLabel` names an author id from the org's members (the facet
 * carries ids only); `showProject` is false on a project's own list, which drops the Project facet
 * as it drops the column.
 */
export function jobsToolbarFacets({
	filters,
	set,
	facets,
	authorLabel,
	showProject,
}: {
	filters: JobsFilters;
	set: SetJobsFilter;
	facets: JobsFacets | undefined;
	authorLabel: (userId: string) => string;
	showProject: boolean;
}): ListToolbarFacet[] {
	const author: ListToolbarFacet = {
		label: "Author",
		icon: Users,
		options: facetOptions(facets?.authors, (o) => authorLabel(o.value)),
		value: filters.authors,
		onChange: (next) => set("authors", next),
		formatValue: authorLabel,
	};
	const environment: ListToolbarFacet = {
		label: "Environment",
		icon: Layers,
		options: facetOptions(facets?.envs),
		value: filters.envs,
		onChange: (next) => set("envs", next),
		formatValue: labelFrom(facets?.envs),
	};
	const project: ListToolbarFacet = {
		label: "Project",
		icon: Boxes,
		options: facetOptions(facets?.projects),
		value: filters.projects,
		onChange: (next) => set("projects", next),
		formatValue: labelFrom(facets?.projects),
	};
	const status: ListToolbarFacet = {
		label: "Status",
		icon: Activity,
		options: facetOptions(facets?.statuses, (o) => statusLabel(o.value)),
		value: filters.statuses,
		onChange: (next) => set("statuses", next),
		formatValue: statusLabel,
	};
	const type: ListToolbarFacet = {
		label: "Type",
		icon: Wrench,
		options: facetOptions(facets?.types, (o) => typeLabel(o.value)),
		value: filters.types,
		onChange: (next) => set("types", next),
		formatValue: typeLabel,
	};
	return showProject ? [author, environment, project, status, type] : [author, environment, status, type];
}

/**
 * The range controls: a quick preset and an explicit window, both writing the one `range` filter.
 * `range` is `filters.range` resolved to dates by the caller, once, so a preset's window does not
 * move on every render (`jobsRangeWindow`). One choice, one label: a preset's name, or "Custom
 * range" over explicit bounds — never a relative name over fixed dates. A preset is stored as its
 * id, so its link stays relative.
 */
export function JobsRangeControls({ filters, set, range }: { filters: JobsFilters; set: SetJobsFilter; range: DateRange }) {
	return (
		<>
			<QuickRangeFilter
				label={rangeFilterLabel(parseRangeFilter(filters.range), JOBS_DEFAULT_RANGE_LABEL)}
				value={range}
				onChange={(picked, label) => set("range", rangeFromPick(picked, label))}
			/>
			<DateRangeFilter value={range} onChange={(picked) => set("range", rangeWindowValue(picked))} />
		</>
	);
}
