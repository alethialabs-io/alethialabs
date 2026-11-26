"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service tokens list's filter bar, in the console filter standard's shared grammar: a search over
// the name and prefix, and a Status facet whose counts come from the UNFILTERED org universe (so an
// option never vanishes as it is picked). Presentational: the values and mutators are the store's.

import type { ServiceTokenFacets } from "@/lib/queries/service-tokens";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useServiceTokenFilters } from "@/lib/stores/use-service-token-filters";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { CircleDot } from "lucide-react";
import { DEFAULT_SERVICE_TOKEN_FILTERS } from "./tokens-filters";
import { TOKEN_STATUS } from "./token-vocab";

/** The store's state, read from the store rather than restated. */
type TokenFilterStore = ReturnType<typeof useServiceTokenFilters.getState>;

/** The filter bar's inputs. */
export interface TokensFilterBarProps {
	filters: TokenFilterStore["filters"];
	onFilter: TokenFilterStore["set"];
	onReset: TokenFilterStore["reset"];
	facets: ServiceTokenFacets | undefined;
}

/** Search + Status, with the mono "Reset · N" of the person's own choices. */
export function TokensFilterBar({ filters, onFilter, onReset, facets }: TokensFilterBarProps) {
	return (
		<FilterBar
			end={<FilterBarReset count={countActiveFilters(filters, DEFAULT_SERVICE_TOKEN_FILTERS)} onReset={onReset} />}
		>
			<FilterSearch
				value={filters.search}
				onChange={(v) => onFilter("search", v)}
				placeholder="Filter by name or prefix…"
				ariaLabel="Search service tokens"
				className="w-[200px] max-w-[320px] flex-1"
			/>
			<FacetFilter
				label="Status"
				icon={CircleDot}
				options={(facets?.status ?? []).map((o) => ({
					value: o.value,
					label: o.value === "active" || o.value === "expired" || o.value === "revoked" ? TOKEN_STATUS[o.value].label : o.value,
					count: o.count,
				}))}
				value={filters.status}
				onChange={(next) => onFilter("status", next)}
			/>
		</FilterBar>
	);
}
