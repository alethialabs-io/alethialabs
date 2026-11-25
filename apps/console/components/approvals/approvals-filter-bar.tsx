"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { Activity, Layers, Send, Wrench } from "lucide-react";
import type { ApprovalFacets } from "@/lib/queries/approvals";
import type { FacetOption } from "@/lib/queries/facets";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useApprovalsFilters } from "@/lib/stores/use-approvals-filters";
import { lookup } from "@/lib/typed-object";
import { DEFAULT_APPROVALS_FILTERS } from "./approvals-query";
import { APPROVAL_STATUS, CREDENTIAL_LABEL, OPERATION_LABEL } from "./approval-vocabulary";

/** The approvals filter store's state; the bar's values and mutators are the store's own. */
type ApprovalsFilterStore = ReturnType<typeof useApprovalsFilters.getState>;

/** Facet options with the client's labels; each carries its count over the unfiltered universe. */
function options(facet: FacetOption[] | undefined, label: (o: FacetOption) => string) {
	return (facet ?? []).map((o) => ({ value: o.value, label: label(o), count: o.count }));
}

/**
 * The approvals list's filter bar (spec §1.3): search, then Status, Operation, Requested through and
 * Environment. Status opens on Waiting — the default view, shown as a real selection the person can
 * clear. Option counts come from the server's facet pass over the unfiltered universe, so picking an
 * option never makes another vanish. No result count anywhere (lib/query/README.md → "Counts").
 */
export function ApprovalsFilterBar({
	filters,
	onFilter,
	onReset,
	facets,
}: {
	filters: ApprovalsFilterStore["filters"];
	onFilter: ApprovalsFilterStore["set"];
	onReset: ApprovalsFilterStore["reset"];
	facets: ApprovalFacets | undefined;
}) {
	return (
		<FilterBar end={<FilterBarReset count={countActiveFilters(filters, DEFAULT_APPROVALS_FILTERS)} onReset={onReset} />}>
			<FilterSearch
				value={filters.search}
				onChange={(v) => onFilter("search", v)}
				placeholder="Search project, environment or digest…"
				ariaLabel="Search approval requests"
				className="w-[220px] max-w-[340px] flex-1"
			/>
			<FacetFilter
				label="Status"
				icon={Activity}
				options={options(facets?.status, (o) => lookup(APPROVAL_STATUS, o.value)?.label ?? o.value)}
				value={filters.status}
				onChange={(next) => onFilter("status", next)}
				searchPlaceholder="Search statuses…"
			/>
			<FacetFilter
				label="Operation"
				icon={Wrench}
				options={options(facets?.operation, (o) => lookup(OPERATION_LABEL, o.value) ?? o.value)}
				value={filters.operation}
				onChange={(next) => onFilter("operation", next)}
				searchPlaceholder="Search operations…"
			/>
			<FacetFilter
				label="Requested through"
				icon={Send}
				options={options(facets?.credential, (o) => lookup(CREDENTIAL_LABEL, o.value) ?? o.value)}
				value={filters.credential}
				onChange={(next) => onFilter("credential", next)}
				searchPlaceholder="Search…"
				emptyText="Nothing has asked yet."
			/>
			<MultiCombobox
				placeholder="All environments"
				icon={Layers}
				options={(facets?.environment ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value, hint: String(o.count) }))}
				value={filters.environment}
				onChange={(next) => onFilter("environment", next)}
			/>
		</FilterBar>
	);
}
