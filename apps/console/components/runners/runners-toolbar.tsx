"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners list's one-row toolbar — the console filter standard (#578) on `ListToolbar`
// (polish-wave spec §3, #7738): search, then the Cloud, Status, Operator, Region and Version
// facets, the mono `Reset · N`, and the section's own buttons pushed right. Reads/writes the page's
// zustand filter store (use-runner-filters); the page owns URL sync + debounce. Every facet count
// was tallied over the UNFILTERED runner set, so a selected option never disappears.

import { Activity, Cloud, Globe, Tag, UserCog } from "lucide-react";
import type { ReactNode } from "react";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { DEFAULT_RUNNER_FILTERS } from "@/components/runners/runners-query";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";

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

/**
 * The runners toolbar. Mounted once per page: it binds `/` to its search. `actions` are the
 * section's own buttons (Add runner), drawn at the far right of the row.
 */
export function RunnersToolbar({
	cloudOptions,
	regionOptions,
	versionOptions,
	actions,
}: {
	cloudOptions: RunnerFacetOption[];
	regionOptions: RunnerFacetOption[];
	versionOptions: RunnerFacetOption[];
	actions?: ReactNode;
}) {
	const filters = useRunnerFilters((s) => s.filters);
	const set = useRunnerFilters((s) => s.set);
	const reset = useRunnerFilters((s) => s.reset);
	const { inputRef, shortcut } = useListSearchShortcut();

	return (
		<ListToolbar
			search={{
				value: filters.search,
				onChange: (v) => set("search", v),
				placeholder: "Search runners by name…",
				ariaLabel: "Search runners",
				inputRef,
				shortcut,
			}}
			facets={[
				{
					label: "Cloud",
					icon: Cloud,
					options: cloudOptions,
					value: filters.clouds,
					onChange: (next) => set("clouds", next),
				},
				{
					label: "Status",
					icon: Activity,
					options: STATUS_OPTIONS,
					value: filters.statuses,
					onChange: (next) => set("statuses", next),
				},
				{
					label: "Operator",
					icon: UserCog,
					options: OPERATOR_OPTIONS,
					value: filters.operators,
					onChange: (next) => set("operators", next),
				},
				{
					label: "Region",
					icon: Globe,
					options: regionOptions,
					value: filters.regions,
					onChange: (next) => set("regions", next),
				},
				{
					label: "Version",
					icon: Tag,
					options: versionOptions,
					value: filters.versions,
					onChange: (next) => set("versions", next),
				},
			]}
			reset={{ count: countActiveFilters(filters, DEFAULT_RUNNER_FILTERS), onReset: reset }}
			actions={actions}
		/>
	);
}

// The predicate that used to live here moved to `lib/queries/runners.ts` with the filtering
// itself (#4890). A filter BAR is the wrong home for "does this row match": the bar renders
// the selections, the SERVER decides what they select.
