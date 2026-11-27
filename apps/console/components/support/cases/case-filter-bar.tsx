"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "My cases" toolbar row — search, the severity and type facets, the lifecycle bucket chips
// (the row's `extra`), the mono reset and the page's actions, laid out by `ListToolbar`: every
// control is a @repo/ui filter primitive, filter state lives in the page's URL-synced zustand
// store, and no result count appears anywhere — the console carries no list counts.
//
// The bucket group is a FilterChipGroup used as a RADIO, not a multi-select: three
// always-visible options where seeing all of them at once is the point, and "All" is the
// off state (which is why re-clicking the live chip is a no-op rather than a deselect).
// It replaces the `Tabs` strip this page used to drive its filtering with — tabs navigate,
// chips filter, and the standard's grammar is chips.

import { AlertTriangle, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { ListToolbar } from "@repo/ui/list-toolbar";
import {
	CASE_BUCKET_LABELS,
	CASE_BUCKETS,
	type CaseFacetOption,
	DEFAULT_SUPPORT_CASE_FILTERS,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSupportFilters } from "@/lib/stores/use-support-filters";

/** The bucket chips, in lifecycle order. Static — the buckets are a closed set. */
const BUCKET_OPTIONS = CASE_BUCKETS.map((value) => ({
	value,
	label: CASE_BUCKET_LABELS[value],
}));

/** A facet's options carrying their row counts in the muted right-hand `hint` slot. */
function withCounts(options: CaseFacetOption[]) {
	return options.map((o) => ({
		value: o.value,
		label: o.label,
		hint: String(o.count),
	}));
}

/**
 * The case list's one `ListToolbar` row: search, the severity and type facets, the bucket chips in
 * `extra`, the mono reset, then the page's `actions` on the right. `severityOptions` / `typeOptions`
 * are computed over the unfiltered rows of the current bucket so an option never vanishes as it is
 * selected. Owns the page's `/` shortcut, so render it once.
 */
export function CaseFilterBar({
	severityOptions,
	typeOptions,
	actions,
}: {
	severityOptions: CaseFacetOption[];
	typeOptions: CaseFacetOption[];
	/** The page's own buttons (Submit a case), on the far right of the row. */
	actions?: ReactNode;
}) {
	const filters = useSupportFilters((s) => s.filters);
	const set = useSupportFilters((s) => s.set);
	const reset = useSupportFilters((s) => s.reset);
	const { inputRef, shortcut } = useListSearchShortcut();

	return (
		<ListToolbar
			search={{
				value: filters.search,
				onChange: (v) => set("search", v),
				placeholder: "Filter by case number or subject…",
				ariaLabel: "Search cases",
				inputRef,
				shortcut,
			}}
			facets={[
				{
					label: "Severity",
					icon: AlertTriangle,
					options: withCounts(severityOptions),
					value: filters.severity,
					onChange: (next: string[]) => set("severity", next),
					searchPlaceholder: "Search severity…",
				},
				{
					label: "Type",
					icon: Tag,
					options: withCounts(typeOptions),
					value: filters.type,
					onChange: (next: string[]) => set("type", next),
					searchPlaceholder: "Search type…",
				},
			]}
			extra={
				<FilterChipGroup
					inline
					options={BUCKET_OPTIONS}
					selected={[filters.bucket]}
					onToggle={(value) => set("bucket", value)}
				/>
			}
			reset={{
				count: countActiveFilters<SupportCaseFilters>(filters, DEFAULT_SUPPORT_CASE_FILTERS),
				onReset: reset,
			}}
			actions={actions}
		/>
	);
}
