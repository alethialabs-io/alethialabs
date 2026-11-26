// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter-bar shell — encodes the console's toolbar layout convention (wrap-friendly
// row, 10px gaps, bottom margin) so pages stop copy-pasting it. Children read left to
// right: search, then facet controls, then the reset. `end` is a right-aligned slot for
// the rare page-level control (an export button) — never for "N of M" result prose: a list
// carries no counts (apps/console/lib/query/README.md, "Counts").
//
// `FilterEmpty` is the other half of a filter bar: what the rows area says when the filters match
// nothing although the list itself is not empty. The empty UNIVERSE keeps its own `EmptyState`,
// with the create action; this one offers the way back out, "Clear filters".

import { Button } from "./button";
import { EmptyState } from "./empty";
import { cn } from "./utils";

interface FilterBarProps {
	children: React.ReactNode;
	/** Right-aligned slot, used sparingly (e.g. an Export action). */
	end?: React.ReactNode;
	className?: string;
}

/** The standard filter-bar row: search + facet controls, wrapping on narrow viewports. */
export function FilterBar({ children, end, className }: FilterBarProps) {
	return (
		<div className={cn("mb-4 flex flex-wrap items-center gap-2.5", className)}>
			{children}
			{end && <div className="ml-auto flex items-center gap-2.5">{end}</div>}
		</div>
	);
}

interface FilterBarResetProps {
	/**
	 * How many filters differ from their defaults — each active facet, the date range and a
	 * non-empty search count one apiece. The button hides at 0.
	 */
	count: number;
	onReset: () => void;
	className?: string;
}

/** The mono "RESET · N" affordance (0.14em tracking) — visible only while any filter is active. */
export function FilterBarReset({ count, onReset, className }: FilterBarResetProps) {
	if (count === 0) return null;
	return (
		<button
			type="button"
			onClick={onReset}
			className={cn(
				"px-1 font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary",
				className,
			)}
		>
			Reset · {count}
		</button>
	);
}

interface FilterEmptyProps {
	/** The plural noun the list holds, lower-case: "runners", "environments". */
	noun: string;
	/** Clears every filter — the same handler as the toolbar's `Reset · N`. */
	onClear: () => void;
	/** Heading level for the line, when this heads the rows region. Omit inside a card. */
	level?: 1 | 2 | 3 | 4 | 5 | 6;
	className?: string;
}

/**
 * The rows area when the filters match nothing but the list is not empty: "No <noun> match these
 * filters." and a **Clear filters** button. Render it when the filtered rows are empty and the
 * universe is not (`universeEmpty === false`); an empty universe keeps its own `EmptyState`.
 *
 * @example
 * {rows.length === 0 && universeEmpty === false ? <FilterEmpty noun="runners" onClear={reset} /> : null}
 */
export function FilterEmpty({ noun, onClear, level, className }: FilterEmptyProps) {
	return (
		<EmptyState
			data-variant="filtered"
			level={level}
			className={className}
			title={`No ${noun} match these filters.`}
			action={
				<Button variant="outline" size="sm" onClick={onClear}>
					Clear filters
				</Button>
			}
		/>
	);
}
