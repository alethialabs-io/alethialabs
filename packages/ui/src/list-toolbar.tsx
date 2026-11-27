// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The list page's filter row, described as DATA rather than assembled by hand (#7734).
//
// Every list page used to compose `FilterBar` + `FilterSearch` + `FacetFilter` + `FilterBarReset`
// itself, and each one chose its own order, its own search width and its own place for the page's
// buttons. `ListToolbar` takes the pieces as props and owns the order:
//
//   search · facets · date range · extra · Reset · N ········· view · actions
//
// This file decides LAYOUT only. It renders the existing pieces unchanged; how they look is the
// design unit's job, and it restyles them in their own files, not here.
//
// The `/` key that focuses the search (#7737) is not bound here either: a page-level key is a row
// of the console's shortcut registry, and this package cannot import it. The console's
// `useListSearchShortcut()` answers `list.search` and returns `{ inputRef, shortcut }`; the page
// passes both through `search`, and the hint appears only once that binding is live.
//
// When the filters match nothing, the rows area renders `FilterEmpty` from `@repo/ui/filter-bar`
// ("No <noun> match these filters." + Clear filters) with the same handler as `reset.onReset`.

import * as React from "react";

import { FacetFilter } from "./facet-filter";
import { FilterBar, FilterBarReset } from "./filter-bar";
import { FilterSearch, type FilterSearchShortcut } from "./filter-search";
import { Skeleton } from "./skeleton";
import { cn } from "./utils";

// The layout class lists, shared by `ListToolbar` and `ListToolbarSkeleton` so the skeleton cannot
// drift from the row it stands in for: a skeleton a few pixels off is a layout shift the moment the
// data lands. `ROW` restates `FilterBar`'s own classes and is passed to it, so a later change to
// `FilterBar` cannot move the real row away from its skeleton without this file saying so.
const ROW = "mb-4 flex flex-wrap items-center gap-2.5";
// Full width on a phone, so the search takes its own line and the controls wrap under it; 260px
// from `sm` up (polish-wave spec §3).
const SEARCH = "w-full sm:w-65";
// `ml-auto` pushes the page's own controls to the far right of the row; when the row wraps they
// stay right-aligned on the last line.
const END = "ml-auto flex items-center gap-2.5";
// A `size="sm"` button, which is what `FacetFilter`'s trigger renders.
const CONTROL_SKELETON = "h-8 w-24 rounded-none";
// `FilterSearch`'s field height.
const SEARCH_SKELETON = "h-9 rounded-sm";

/** The props one `FacetFilter` takes; `ListToolbar` renders one per entry, in order. */
export type ListToolbarFacet = React.ComponentProps<typeof FacetFilter>;

/** The free-text search at the start of the row. */
export interface ListToolbarSearch {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name; falls back to the placeholder. */
	ariaLabel?: string;
	/** The search input, for the console's `/` shortcut to focus (`useListSearchShortcut`). */
	inputRef?: React.Ref<HTMLInputElement>;
	/**
	 * The live shortcut that focuses the search, from `useListSearchShortcut`: shows the `/` hint and
	 * sets `aria-keyshortcuts`. Omit it and no hint is drawn.
	 */
	shortcut?: FilterSearchShortcut;
}

/** The `Reset · N` affordance: hidden while `count` is 0. */
export interface ListToolbarReset {
	/** How many filters differ from their defaults: active facets, the date range, and the search. */
	count: number;
	onReset: () => void;
}

export interface ListToolbarProps {
	/** The free-text search, first in the row. */
	search?: ListToolbarSearch;
	/** One `FacetFilter` per entry, after the search. Keyed by `label`, which must be unique. */
	facets?: ListToolbarFacet[];
	/** A date-range control (`DateRangeFilter`, `QuickRangeFilter`), after the facets. */
	dateRange?: React.ReactNode;
	/** Any other filter control, after the date range and before the reset. */
	extra?: React.ReactNode;
	/** The `Reset · N` affordance, after every filter. */
	reset?: ListToolbarReset;
	/** A view switch (`ViewToggle`), at the start of the right-aligned group. */
	view?: React.ReactNode;
	/** The page's own buttons, last in the row and pushed to the far right. */
	actions?: React.ReactNode;
	className?: string;
}

/**
 * The list page's filter row, from config: search on the left, then the facets, the date range and
 * any extra control, then `Reset · N`, then the view switch and the page's actions pushed right.
 * Wraps on narrow screens.
 *
 * Renders nothing when given nothing, so a page with no filters gets no empty row.
 *
 * @example
 * const { inputRef, shortcut } = useListSearchShortcut(); // console: @/lib/shortcuts/use-list-search-shortcut
 * <ListToolbar
 *   search={{ value: q, onChange: setQ, placeholder: "Search runners", inputRef, shortcut }}
 *   facets={[{ label: "Status", options, value: status, onChange: setStatus }]}
 *   reset={{ count: active, onReset: clear }}
 *   actions={<Button size="sm">Add runner</Button>}
 * />
 */
export function ListToolbar({
	search,
	facets,
	dateRange,
	extra,
	reset,
	view,
	actions,
	className,
}: ListToolbarProps) {
	const hasFacets = facets !== undefined && facets.length > 0;
	const hasEnd = view != null || actions != null;
	if (
		search === undefined &&
		!hasFacets &&
		dateRange == null &&
		extra == null &&
		reset === undefined &&
		!hasEnd
	) {
		return null;
	}
	return (
		<FilterBar className={cn(ROW, className)}>
			{search ? (
				<FilterSearch
					className={SEARCH}
					value={search.value}
					onChange={search.onChange}
					placeholder={search.placeholder}
					ariaLabel={search.ariaLabel}
					inputRef={search.inputRef}
					shortcut={search.shortcut}
				/>
			) : null}
			{hasFacets ? facets.map((facet) => <FacetFilter key={facet.label} {...facet} />) : null}
			{dateRange}
			{extra}
			{reset ? <FilterBarReset count={reset.count} onReset={reset.onReset} /> : null}
			{hasEnd ? (
				<div data-slot="list-toolbar-end" className={END}>
					{view}
					{actions}
				</div>
			) : null}
		</FilterBar>
	);
}

export interface ListToolbarSkeletonProps {
	/** The real toolbar has a search. Defaults to true. */
	search?: boolean;
	/** How many facets the real toolbar shows. */
	facets?: number;
	/** The real toolbar has a date-range control. */
	dateRange?: boolean;
	/** The real toolbar has a view switch. */
	view?: boolean;
	/** How many action buttons the real toolbar shows. */
	actions?: number;
	className?: string;
}

/**
 * The loading form of {@link ListToolbar}: the same row, built from the same layout classes, with a
 * placeholder where each control will be. Say which parts the real toolbar has, so each placeholder
 * takes the space its control will. `Reset · N` has no placeholder: it is hidden until a filter is
 * set, and nothing is set while the page is loading.
 *
 * Renders nothing when asked for nothing.
 *
 * @example
 * <ListToolbarSkeleton facets={2} actions={1} />
 */
export function ListToolbarSkeleton({
	search = true,
	facets = 0,
	dateRange = false,
	view = false,
	actions = 0,
	className,
}: ListToolbarSkeletonProps) {
	const hasEnd = view || actions > 0;
	if (!search && facets <= 0 && !dateRange && !hasEnd) return null;
	return (
		<div data-slot="list-toolbar-skeleton" aria-hidden className={cn(ROW, className)}>
			{search ? <Skeleton data-part="search" className={cn(SEARCH, SEARCH_SKELETON)} /> : null}
			{Array.from({ length: Math.max(0, facets) }, (_, i) => (
				<Skeleton key={`facet-${i}`} data-part="facet" className={CONTROL_SKELETON} />
			))}
			{dateRange ? <Skeleton data-part="date-range" className={CONTROL_SKELETON} /> : null}
			{hasEnd ? (
				<div className={END}>
					{view ? <Skeleton data-part="view" className={CONTROL_SKELETON} /> : null}
					{Array.from({ length: Math.max(0, actions) }, (_, i) => (
						<Skeleton key={`action-${i}`} data-part="action" className={CONTROL_SKELETON} />
					))}
				</div>
			) : null}
		</div>
	);
}
