"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service tokens list's one toolbar row (`ListToolbar`), in the console filter standard's shared grammar: a search over
// the name and prefix, and a Status facet whose counts come from the UNFILTERED org universe (so an
// option never vanishes as it is picked). Presentational: the values and mutators are the store's.

import type { ServiceTokenFacets } from "@/lib/queries/service-tokens";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import type { useServiceTokenFilters } from "@/lib/stores/use-service-token-filters";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { CircleDot } from "lucide-react";
import type { ReactNode } from "react";
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
	/** The page's own buttons (Create token), on the far right of the row. */
	actions?: ReactNode;
}

/**
 * The page's one `ListToolbar` row: search + Status, the mono "Reset · N" of the person's own
 * choices, then the page's actions on the right. Owns the page's `/` shortcut, so render it once.
 */
export function TokensFilterBar({ filters, onFilter, onReset, facets, actions }: TokensFilterBarProps) {
	const { inputRef, shortcut } = useListSearchShortcut();
	return (
		<ListToolbar
			search={{
				value: filters.search,
				onChange: (v) => onFilter("search", v),
				placeholder: "Filter by name or prefix…",
				ariaLabel: "Search service tokens",
				inputRef,
				shortcut,
			}}
			facets={[
				{
					label: "Status",
					icon: CircleDot,
					options: (facets?.status ?? []).map((o) => ({
						value: o.value,
						label:
							o.value === "active" || o.value === "expired" || o.value === "revoked" ? TOKEN_STATUS[o.value].label : o.value,
						count: o.count,
					})),
					value: filters.status,
					onChange: (next: string[]) => onFilter("status", next),
				},
			]}
			reset={{ count: countActiveFilters(filters, DEFAULT_SERVICE_TOKEN_FILTERS), onReset }}
			actions={actions}
		/>
	);
}
